---
name: Canonical-tree identity can flip between sessions; verify test baselines directly
description: replit.md's SOURCE OF TRUTH banner for artifacts/travel-buddy vs travel-buddy-standalone can change day-to-day; don't trust prior-session conclusions about which tree is canonical, and don't trust a remembered pass/fail baseline without re-measuring.
---

# Canonical-tree identity is not stable — re-check replit.md every session

RESOLVED 2026-08-14: the flip-flopping ended by removing one side. `artifacts/travel-buddy` is archived at `bc1bef404`, so there is nothing left to flip to — but the second half of this memory (never trust a remembered pass/fail baseline without re-measuring) still stands. Historical detail follows.

`replit.md` carries a live "SOURCE OF TRUTH" declaration for which of `artifacts/travel-buddy` / `travel-buddy-standalone` is canonical. It flipped within a single day (2026-08-05): `artifacts/travel-buddy` was deleted, then resurrected the same day as a LEGACY-FROZEN/do-not-edit archival copy, with `travel-buddy-standalone` promoted to sole canonical tree.

**Why:** a task file or instructions written even hours earlier can describe a tree as canonical that is no longer canonical by the time you execute it. Trusting an earlier-session (or earlier-paragraph) conclusion about tree identity causes real edits to land in the wrong tree.

**How to apply:** before any cross-tree change (rebrand, refactor, bugfix meant for "the app"), re-read replit.md's current SOURCE OF TRUTH banner fresh — do not rely on memory of which tree was canonical last time, and do not trust a task file's framing of tree identity without cross-checking it against the live banner.

# Don't trust a remembered pass/fail baseline — measure a clean A/B instead

When asked "did the failure count go up after my change," a remembered number (e.g. "74 known failures") can be stale relative to the current test suite size/composition (the suite here had grown to 1633 total component tests with ~459 pre-existing jest.mock-factory failures, nothing like the old figure). Also, running two invocations of the same Jest suite concurrently against the same tree (e.g. two workflows both executing `test:component` on `travel-buddy-standalone` at once) corrupts shared Jest/transform caches and inflates the failure count as an artifact, not a real regression — and can leave a `run-node-tests.mjs`/jest process hung at 0% CPU indefinitely (kill and rerun serially).

**How to apply:** to verify "did my change break tests," `git stash` just your change, run the suite once for a clean baseline, `git stash pop`, run it again, and diff the two totals directly — don't compare against a remembered number from a different session. Never run the same test workflow twice concurrently on the same tree.
