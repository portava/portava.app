# What the truth percentage would be with flags, deployment and merge removed

**Measured 2026-09-08.** The question: the census percentages score requirements
against the tree, but some verdicts are scored down because a migration is
unapplied, a flag is FALSE, or the fix sits in an unmerged PR. If none of that
counted against a surface, how much would the number move?

**Answer: 43.5 % → 44.3 % correct. Seven tenths of a percentage point.**

Almost nothing about the truth percentage is a deployment problem.

## Method, and why it is a hand count over a machine shortlist

A regex over census evidence cells shortlisted every `W` or `N` row whose text
mentions an unapplied migration, a FALSE flag, or an unmerged PR. That produced
**39 candidates out of 1,489 W/N rows.** Thirty-nine is small enough to read, so
every one was read, because the shortlist is not trustworthy on its own — three
of the 39 matched on English rather than on deployment:

- **P42** — "The weighting exists on the supply side and is **not applied** on the
  demand side." Nothing to do with a migration.
- **T422** — "Reduced motion is **not applied**."
- **TR368** — "returns `{featureEnabled: false, …}` rather than an error when the
  **flag is off**" — a sentence describing correct degradation, quoted as
  evidence that the degradation is real.

A keyword classifier would have credited all three. This is exactly why the
count below is a hand count with the rows named, not a script's number.

## The three levers, separated

| Lever | Rows that would flip `W`/`N` → `C` | Which |
|---|---|---|
| **Migration applied** | **13** | H46, H75, H82, H89, H90, H91, H175, H188, H200 (Highlights/Memories storage: 2720/2721/2723/2710), G57 (2220 `search_key`), L1, L5, L240 (2700) |
| **Flag enabled** | **4** | L128 (`layover_presence_ladder_enabled`), M139 (client projection is the live path with the flag off), MD29 (`MEDIA_WORLD_SHELL_ENABLED`), MD445 |
| **PR merged** | **9** | H18, H19 (#470), L48 (#463), T79, T220, T326, T387 (#472), T344, T438 (#460) |
| **TOTAL** | **26** | |

## Ten more where deployment is *one* reason and not the reason

These matched the shortlist and are NOT credited, because the row would still be
`W` with the migration applied and the flag on. Naming them is the point: a
generous reading would have swept them in.

| Row | The other reason |
|---|---|
| H13 | "**Test-only**" — no production caller, independent of 2730 |
| H98 | "and its committed migration is **broken**" |
| H187 | "Still **no such control on a Memory** — this is the Highlights surface only" |
| H210 | "**no personalization path consults it**" |
| L147 | Route is `null` (`no_routing_provider`), crew notification `[]` (`no_crew_storage`) — two of six effects missing for non-deployment reasons |
| L191 | "It takes **inputs**, not `(sessionId, engineVersion)`" — a signature that does not match the spec |
| P45 | The code **substitutes the neutral 50** and calls every user "Established"; that substitution is a defect with or without `trust_engine_enabled` |
| TR188 | "on its **own endpoint rather than on a projection**" |
| TR314 | "of *preparation*, not of the journey, with **no DISRUPTED state and no runtime input**" |
| TR359 | "carries **no `generatedAt`, no version and no freshness**" |

## The numbers

Baseline is `check:census-integrity`'s own recount of the tables — C 1428,
W 750, N 739, X 3, 2920 parsed rows, 3284 stated denominators.

| Measure | As scored | With all three levers removed |
|---|---|---|
| BUILT-AND-CORRECT | 1428 | **1454** |
| CORRECT % of parsed rows | 48.9 % | **49.8 %** |
| CORRECT % of stated denominators | 43.5 % | **44.3 %** |
| CONSTRUCTED % of denominators | 66.3 % | **66.5 %** |

CONSTRUCTED barely moves because 21 of the 26 are `W → C`, and `W` was already
counted as constructed. Only five are `N → C` (H18, H19, L48, T326, T387) — all
five being requirements whose implementation exists solely in an unmerged PR.

## What this does and does not say

It says the gap between 44 % and 100 % is **not** waiting on an apply, a flag
flip or a merge. It is code that does not do what its spec says, code with no
caller, and requirements with nothing written for them at all.

It does not say the deployment gap is unimportant — 0 of 21 surfaces are
`PRODUCTION_REALIZED` and that dominates what a *user* can do. It says the two
gaps are nearly disjoint: closing every deployment gap tomorrow would move this
number by less than one point.

Nine of the 26 credit work in **someone else's unmerged branch**. If "removing
merge" means only "ignore that this branch is unmerged" rather than "count every
branch", subtract those nine: 1445 / 3284 = **44.0 %**.
