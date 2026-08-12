# Portava — artifacts, 2026-08-10

Four files. **Read `ERRATA.md` first** — it lists the known defects and the one claim of mine
you should trust least.

## What each is

**`00_VERIFIED_STATE.md`** (1385 lines) — the canonical FACT layer, per the rule that a fact is
written once and cited, never restated. Every entry carries a provenance tag:

| tag | meaning |
|---|---|
| `[CLONE 13dcfe3]` | read in the clone with file:line |
| `[DB <date> · <project>]` | live query — **void if it does not name the project** |
| `[LIVE <commit>]` | verified against the live repo by another agent; needs re-verification |
| `[UNVERIFIED]` | believed, unproven, **not citable** |

§10 is KNOWN UNRESOLVED — open questions stated as questions, including the four quarantine
blockers (1–3 resolved, 4 is your scoping decision) and every fact with no clone anchor.

**`upload-ingest-consolidation.md`** (492) — design brief for the last P0. Current state with
anchors, then PROPOSALS. §4 carries a hand-verified correction: the moderation gate does **not**
contain a pending object, which is the strongest argument for the staging boundary.

**`ci-readme-addition.md`** (252) — a section for `docs/ci/README.md`. **Do not merge as-is.**
Its thesis rests on the token-scoping claim that `ERRATA` flags.

**`DECISIONS.md`** (142) — the decision log. What was chosen and why, which decisions are HELD
and precisely what unblocks each, and a list of claims I made that turned out wrong. The fact
layer records what is true; commits record what changed; this records what was decided. It is
the only one of the five that could not be reconstructed from the repository.

**`ERRATA.md`** (137) — known defects, both verification rounds.

## What is NOT in here, and why

Nothing that would change production. No branch protection, no drift application, no policy
change, no flag enabled, no reaper. Those are owner-controlled state changes, and the automation
refusing to repoint a CI-only apply script at production is a safety property working, not
friction.

## Before any of this enters the repo

The governing rule you set: **no P1 architecture work may use an unverified factual claim as a
prerequisite.** Every `[UNVERIFIED]` in §10 is a prerequisite that is not yet met. The two worth
settling first are §9.9 (token scoping) and §2.9 (which project the `post_event_links` RLS
observation came from — the guarded-DO argument rests on it and the tag does not name a project).
