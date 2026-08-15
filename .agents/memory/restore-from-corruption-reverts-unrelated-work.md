---
name: Verify a named cause before accepting it — the autocomplete case was mis-attributed twice
description: Twice a commit was blamed for the empty-autocomplete defect and twice the history refuted it; the migration was removed deliberately by a documented drift-revert, not lost by accident, so the fix was to redo it cleanly — never to restore the reverted commit.
---

When a bug report names a commit as the cause, **verify the attribution against the
history before acting on it.** On 2026-08-15 the same defect — `/api/places/google-autocomplete`
returning `{"places":[]}` for every input with a demonstrably working key — was
attributed to a specific commit twice, and **both attributions were wrong.**

## What was claimed, and what the history says

| Claim | Refuted by |
|---|---|
| `cd1f4e1bb` (the New-API migration) broke autocomplete | It moved the route **toward** the API that works. The live code was on the *legacy* endpoint. |
| `d713e58ee` ("the places.ts repair") silently reverted the migration as collateral | Its diff of `routes/places.ts` contains **zero** added or removed lines matching `autocomplete` or `google-details`, and it **predates** `cd1f4e1bb` by 80 minutes. |

**What actually removed the migration: `87e245786`** — a deliberate revert of five
unreviewed local commits, with a long written rationale. `cd1f4e1bb` had bundled a
real API migration together with changes that had **not passed CI**, including one
that collapsed the photo fallback chain from Google→Foursquare to **Foursquare→Foursquare**.

**And the true cause of the defect was neither commit.** The legacy endpoint had
been in place continuously since 2026-07-27 and still was. **There was no
regression at all** — the code had always called the API that later refused it.
What changed was outside the repository.

## ⚠ The trap this file previously set

An earlier version of this note said the migration was **silently reverted as
collateral of a corruption repair**. That framing invites exactly one response —
*restore it* — and the commit it would restore is `cd1f4e1bb`, whose FSQ→FSQ
collapse would take Discovery's photos out **entirely** the next time Foursquare
returns 429. Which it did, the same day.

**A memory note that invites re-applying a reverted commit is worse than no note.**

## Why

The removal was **deliberate, instructed, and documented** — not silent, not
accidental. The framing was backwards in the way that matters: it recast an
intentional decision as an accident, and accidents invite undoing.

**The correct response to a deliberately reverted commit is never to restore it
blindly. It is to redo the good part cleanly**, on its own branch, through CI —
which is what happened: the migration was re-landed separately, with the failure
made observable first and with tests these routes had never had.

## How to apply

- **When a bug report names a commit, check it before accepting it.** `git log -S "<distinctive string>" --all -- <path>` for when a string entered and left, `git log -1 --format=%ci` on each candidate to put them in real order, and read the *diff* for whether it touched the handler at all. Commit **messages** describe intent; only diffs and timestamps are evidence.
- **Beware the satisfying answer.** Both wrong attributions pointed at a commit, and a commit is satisfying because it implies a revert will fix it. **A defect with no regression is the one most likely to be mis-attributed**, because "what changed?" is the first question anyone asks and sometimes the answer is "nothing here."
- **Before restoring anything reverted, read the revert's message.** If it names reasons, those reasons still apply. A revert with a written rationale is a decision, not damage.
- The original hazard this file described — a whole-file "restore from corruption" discarding intervening intentional work — **is real and worth watching for.** It just is not what happened here, and two commits that day did describe themselves that way (`cf4d8a674`, `3fe369046`) without touching these handlers.

See `docs/places/google-legacy-places-api-returns-nothing.md` for the full filing.
