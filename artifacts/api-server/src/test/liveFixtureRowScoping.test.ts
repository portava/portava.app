/**
 * liveFixtureRowScoping — a fixture sweep must not delete another run's ROWS.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * PR #421 run-scoped the live suites' auth users: an address became
 * `stem+r<run id>@domain`, and the sweep learned to spare an address belonging
 * to a run that might still be alive. It fixed `auth.users` and nothing else.
 *
 * `src/test/rlsHardening.test.ts` creates ordinary rows alongside those users
 * and identified them by DETERMINISTIC constants:
 *
 *     FIXTURE_HANDLES     = ["rls_hardening_test_private", "…_public"]
 *     FIXTURE_EVENT_TITLE = "rls_hardening_test_private_event"
 *     FIXTURE_TRIP_TITLE  = "rls_hardening_test_private_trip"
 *
 * and its `purgeFixtures()` deleted `trips` where `title` equalled the trip
 * constant, `events` where `title` equalled the event constant, and `profiles`
 * where `handle` was one of the two. Those strings are IDENTICAL in every
 * process. Two concurrent runs — or two attempts of the same run, which is the
 * routine case on this repository — therefore deleted each other's trip, event
 * and profile rows mid-suite, and the profile half additionally collides on
 * `profiles_handle_key`, which is UNIQUE.
 *
 * The consequence is worse than a red job. Every assertion in that suite is of
 * the form "reading this row returns nothing". A peer's purge between `before`
 * and the assertions makes them all pass for the wrong reason: the row is not
 * hidden, it is deleted. A hardening suite that goes green because its fixtures
 * were removed proves nothing about RLS.
 *
 * ── THE FIX, AND WHY IT IS TWO HALVES ───────────────────────────────────────
 * `fixtureLabel()` appends `_r<run id>` — the label counterpart of the
 * `+r<run id>` sub-address `fixtureEmail()` appends — and
 * `purgeFixtureRowsDetailed` routes every candidate through `decideSweep`, the
 * same single decision the auth-user sweep uses.
 *
 * Neither half stands alone, and #421 measured both failure modes:
 *   • Run-id scoping ALONE is inert. Every genuinely stranded row carries some
 *     other run's id, so nothing would ever be swept and orphans accumulate.
 *   • Age ALONE breaks teardown. The purge IS the `after` path; it must clear
 *     rows created seconds ago.
 *
 * ── WHAT THIS FILE PROVES, WITHOUT A DATABASE ───────────────────────────────
 * The decision is a pure function of (label, base labels, row age, clock), and
 * the sweeper's only dependency is an admin client. The client here is a
 * hand-written double that hands back rows and records deletes, so this runs in
 * the ordinary `npm test` tier — the tier that executes regardless of what any
 * live database is doing.
 *
 * NO credential env var is named in this file, deliberately — see
 * scripts/check-guard-coverage.mjs.
 *
 * ── MUTATION PROOF ─────────────────────────────────────────────────────────
 * Two mutations, each restoring one half of the pre-fix behaviour:
 *
 *   (a) THE BROAD MATCH. In `decideSweep`, drop the age half:
 *           return scope !== null;
 *       → "LEAVES A CONCURRENT RUN'S ROWS ALONE" and "refuses a row whose age
 *         it cannot determine" go RED; the not-inert assertions stay green.
 *
 *   (b) THE UN-SCOPED CONSTANTS. In `fixtureLabel`, return the base unchanged:
 *           return base;
 *       → "this run's own label is mine" and the rlsHardening source guard go
 *         RED, because every run's label is once again the same string.
 *
 * Restoring the real implementations returns every assertion to green. Both
 * were run; a sweep test that passes under the broken sweep is worth nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_RUN_ID,
  FIXTURE_SWEEP_MIN_AGE_MS,
  classifyFixtureLabel,
  decideSweep,
  fixtureLabel,
  isSweepableFixtureRow,
  purgeFixtureRowsDetailed,
} from "./liveFixtureUsers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const BASE_TRIP = "rowscope_probe_trip";
const BASE_EVENT = "rowscope_probe_event";

const PEER_RUN = "peerrun00001";
const DEAD_RUN = "deadrun99999";

/** `<base>_r<id>` for an arbitrary run id — what a peer's label looks like. */
function labelOfRun(base: string, runId: string): string {
  return `${base}_r${runId}`;
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

describe("classifyFixtureLabel — whose row is this", () => {
  it("recognises THIS run's label as mine", () => {
    assert.equal(classifyFixtureLabel(fixtureLabel(BASE_TRIP), BASE_TRIP), "mine");
  });

  it("recognises another run's label as foreign, not as mine", () => {
    assert.equal(classifyFixtureLabel(labelOfRun(BASE_TRIP, PEER_RUN), BASE_TRIP), "foreign");
    // The bug this forbids: a run id that merely CONTAINS ours, or vice versa.
    assert.equal(classifyFixtureLabel(labelOfRun(BASE_TRIP, `${FIXTURE_RUN_ID}x`), BASE_TRIP), "foreign");
    assert.equal(classifyFixtureLabel(labelOfRun(BASE_TRIP, `x${FIXTURE_RUN_ID}`), BASE_TRIP), "foreign");
  });

  it("recognises a pre-run-scoping label as unscoped", () => {
    assert.equal(classifyFixtureLabel(BASE_TRIP, BASE_TRIP), "unscoped");
  });

  it("is case-sensitive — a handle is stored verbatim, unlike an address", () => {
    assert.equal(classifyFixtureLabel(fixtureLabel(BASE_TRIP).toUpperCase(), BASE_TRIP), null);
  });

  it("rejects everything that is not one of ours", () => {
    assert.equal(classifyFixtureLabel("rowscope_probe_trip_x", BASE_TRIP), null);
    assert.equal(classifyFixtureLabel(`${BASE_TRIP}_r`, BASE_TRIP), null, "an empty run id is not a run id");
    assert.equal(classifyFixtureLabel("", BASE_TRIP), null);
    // The near-miss that matters: this suite's own sibling constants share a
    // prefix (`…_private` vs `…_private_event`) and must not classify as each
    // other's scoped variants.
    assert.equal(classifyFixtureLabel("rls_hardening_test_private_event", "rls_hardening_test_private"), null);
  });
});

describe("isSweepableFixtureRow — the one delete decision, applied to a row", () => {
  const now = Date.now();
  const row = (title: string, ageMs: number | null) => ({
    id: title,
    title,
    ...(ageMs === null ? {} : { created_at: new Date(now - ageMs).toISOString() }),
  });

  it("sweeps THIS run's row at any age — that is the teardown path", () => {
    assert.equal(isSweepableFixtureRow(row(fixtureLabel(BASE_TRIP), 0), "title", [BASE_TRIP], now), true);
    assert.equal(isSweepableFixtureRow(row(fixtureLabel(BASE_TRIP), 5 * HOUR), "title", [BASE_TRIP], now), true);
  });

  it("REFUSES a live peer's row — the defect this file exists for", () => {
    assert.equal(
      isSweepableFixtureRow(row(labelOfRun(BASE_TRIP, PEER_RUN), 30_000), "title", [BASE_TRIP], now),
      false,
      "a fixture row created 30 seconds ago belongs to a run that is still asserting against it",
    );
  });

  it("sweeps a genuinely stranded row from a dead run", () => {
    assert.equal(
      isSweepableFixtureRow(row(labelOfRun(BASE_TRIP, DEAD_RUN), 6 * HOUR), "title", [BASE_TRIP], now),
      true,
      "if this stops being true, stranded fixture rows accumulate forever",
    );
  });

  it("sweeps an old pre-run-scoping row and spares a fresh one", () => {
    assert.equal(isSweepableFixtureRow(row(BASE_TRIP, 6 * HOUR), "title", [BASE_TRIP], now), true);
    assert.equal(isSweepableFixtureRow(row(BASE_TRIP, 30_000), "title", [BASE_TRIP], now), false);
  });

  it("refuses a row whose age it cannot determine", () => {
    // "I could not tell how old it is" is not "it is old". For a row this is not
    // hypothetical: a select that forgot to ask for created_at would otherwise
    // make every peer's live row sweepable.
    assert.equal(isSweepableFixtureRow(row(labelOfRun(BASE_TRIP, DEAD_RUN), null), "title", [BASE_TRIP], now), false);
    assert.equal(
      isSweepableFixtureRow(
        { id: "x", title: labelOfRun(BASE_TRIP, DEAD_RUN), created_at: "not a date" },
        "title",
        [BASE_TRIP],
        now,
      ),
      false,
    );
  });

  it("reads the column it is told to read, and nothing else", () => {
    const r = { id: "x", handle: fixtureLabel(BASE_TRIP), title: "something else", created_at: iso(0) };
    assert.equal(isSweepableFixtureRow(r, "handle", [BASE_TRIP], now), true);
    assert.equal(isSweepableFixtureRow(r, "title", [BASE_TRIP], now), false);
  });

  it("never sweeps a row that is not one of ours", () => {
    assert.equal(isSweepableFixtureRow(row("someone else's trip", 9 * HOUR), "title", [BASE_TRIP], now), false);
  });

  it("shares the age threshold with the auth-user sweep, and it outlasts a live job", () => {
    // One threshold, one rule. live-db.yml caps its DB jobs at 45 minutes.
    assert.ok(
      FIXTURE_SWEEP_MIN_AGE_MS >= 60 * MINUTE,
      `the peer-protection window is ${FIXTURE_SWEEP_MIN_AGE_MS}ms, shorter than a live-DB job may run`,
    );
    assert.equal(decideSweep("mine", null, now), true);
    assert.equal(decideSweep("foreign", now - MINUTE, now), false);
    assert.equal(decideSweep("foreign", now - 6 * HOUR, now), true);
    assert.equal(decideSweep("unscoped", null, now), false);
    assert.equal(decideSweep(null, now - 9 * HOUR, now), false);
  });
});

/**
 * A minimal admin double. `select(...).like(col, pattern)` applies the SQL LIKE
 * semantics the real prefilter has — including `_` as a single-character
 * wildcard, which is the whole reason the sweeper treats the prefilter as a
 * candidate list rather than a delete list. `delete().eq("id", …)` records.
 */
function fakeAdmin(tables: Record<string, Array<Record<string, unknown>>>) {
  const deletedIds: string[] = [];
  const patterns: string[] = [];

  const likeToRegExp = (pattern: string) =>
    new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`,
    );

  return {
    deletedIds,
    patterns,
    remaining: (table: string) => (tables[table] ?? []).map((r) => String(r.id)),
    from(table: string) {
      return {
        select: (_cols: string) => ({
          like: async (col: string, pattern: string) => {
            patterns.push(pattern);
            const re = likeToRegExp(pattern);
            return {
              data: (tables[table] ?? []).filter((r) => typeof r[col] === "string" && re.test(r[col] as string)),
              error: null,
            };
          },
        }),
        delete: () => ({
          eq: async (_col: string, id: string) => {
            deletedIds.push(id);
            tables[table] = (tables[table] ?? []).filter((r) => String(r.id) !== id);
            return { error: null };
          },
        }),
      };
    },
  };
}

describe("purgeFixtureRowsDetailed — a sweep by run A must not touch run B's rows", () => {
  const MINE = fixtureLabel(BASE_TRIP);
  const PEER = labelOfRun(BASE_TRIP, PEER_RUN);
  const STRANDED = labelOfRun(BASE_TRIP, DEAD_RUN);

  const trips = () => [
    { id: "t-mine", title: MINE, created_at: iso(2_000) },
    { id: "t-peer", title: PEER, created_at: iso(30_000) },
    { id: "t-stranded", title: STRANDED, created_at: iso(6 * HOUR) },
    { id: "t-legacy-old", title: BASE_TRIP, created_at: iso(6 * HOUR) },
    { id: "t-undatable", title: labelOfRun(BASE_TRIP, "undatable01") },
    { id: "t-unrelated", title: "a real user's trip", created_at: iso(9 * HOUR) },
    // Caught by the widened LIKE prefilter (`_` is a wildcard), rejected by the
    // exact classification. Proves the prefilter cannot widen the delete.
    { id: "t-prefilter-only", title: "rowscopeXprobeXtrip_rSOMETHING", created_at: iso(9 * HOUR) },
  ];

  it("deletes this run's own row, and the stranded ones, and nothing else", async () => {
    const admin = fakeAdmin({ trips: trips() });
    const outcome = await purgeFixtureRowsDetailed(admin, "trips", "title", [BASE_TRIP]);

    assert.deepEqual(outcome.failed, [], "no delete should have been refused by the double");
    assert.deepEqual(
      admin.deletedIds.slice().sort(),
      ["t-legacy-old", "t-mine", "t-stranded"],
      "the sweep must take exactly: this run's own row, a stranded run-scoped leftover, " +
        "and an old pre-run-scoping row",
    );
  });

  it("LEAVES A CONCURRENT RUN'S ROWS ALONE — the regression this file exists for", async () => {
    const admin = fakeAdmin({ trips: trips() });
    await purgeFixtureRowsDetailed(admin, "trips", "title", [BASE_TRIP]);

    assert.ok(
      !admin.deletedIds.includes("t-peer"),
      "the sweep deleted a live concurrent run's fixture trip. That is the defect: run A's " +
        "before-hook purge removes run B's rows mid-suite, and B's 'RLS returned nothing' " +
        "assertions then pass because the row is gone rather than because it is hidden.",
    );
    assert.ok(!admin.deletedIds.includes("t-undatable"), "a row of unknown age was deleted");
    assert.ok(!admin.deletedIds.includes("t-unrelated"), "a row that is not ours was deleted");
    assert.ok(
      !admin.deletedIds.includes("t-prefilter-only"),
      "a row matched only by the widened LIKE prefilter was deleted; the prefilter must never widen the delete",
    );
    assert.ok(admin.remaining("trips").includes("t-peer"), "the peer's row must still be in the table");
  });

  it("still sweeps genuinely stranded rows — the sweep must not become inert", async () => {
    // Deleting NOTHING would also satisfy the assertion above. It is not a fix:
    // a sweep that never fires lets orphaned fixture rows accumulate and the
    // unique handle constraint eventually blocks every run.
    const admin = fakeAdmin({ trips: trips() });
    await purgeFixtureRowsDetailed(admin, "trips", "title", [BASE_TRIP]);
    assert.ok(admin.deletedIds.includes("t-stranded"), "the orphan sweep stopped working");
    assert.ok(admin.deletedIds.includes("t-mine"), "teardown of this run's own row stopped working");
    assert.ok(admin.deletedIds.length >= 3, "a sweep that deletes (almost) nothing lets orphans accumulate");
  });

  it("reports what it spared, so an inert sweep is visible rather than silent", async () => {
    const admin = fakeAdmin({ trips: trips() });
    const outcome = await purgeFixtureRowsDetailed(admin, "trips", "title", [BASE_TRIP]);
    assert.ok(outcome.spared.includes(PEER));
    assert.ok(outcome.spared.includes(labelOfRun(BASE_TRIP, "undatable01")));
  });

  it("reports a refused delete instead of counting it as a success", async () => {
    const admin = {
      from: (_t: string) => ({
        select: () => ({ like: async () => ({ data: [{ id: "t-mine", title: MINE, created_at: iso(0) }], error: null }) }),
        delete: () => ({ eq: async () => ({ error: { message: "permission denied" } }) }),
      }),
    };
    const outcome = await purgeFixtureRowsDetailed(admin, "trips", "title", [BASE_TRIP]);
    assert.deepEqual(outcome.deleted, [], "a refused delete must not be reported as a deletion");
    assert.equal(outcome.failed.length, 1);
    assert.match(outcome.failed[0].reason, /permission denied/);
  });

  it("reports a refused lookup and never throws out of a teardown", async () => {
    const admin = {
      from: (_t: string) => ({
        select: () => ({ like: async () => ({ data: null, error: { message: "relation does not exist" } }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      }),
    };
    const outcome = await purgeFixtureRowsDetailed(admin, "trips", "title", [BASE_TRIP]);
    assert.deepEqual(outcome.deleted, []);
    assert.equal(outcome.failed.length, 1);
    assert.match(outcome.failed[0].reason, /relation does not exist/);
  });

  it("sweeps several bases in one call without double-deleting a row", async () => {
    const admin = fakeAdmin({
      profiles: [
        { id: "p-a", handle: fixtureLabel(BASE_TRIP), created_at: iso(1_000) },
        { id: "p-b", handle: fixtureLabel(BASE_EVENT), created_at: iso(1_000) },
        { id: "p-peer", handle: labelOfRun(BASE_EVENT, PEER_RUN), created_at: iso(1_000) },
      ],
    });
    const outcome = await purgeFixtureRowsDetailed(admin, "profiles", "handle", [BASE_TRIP, BASE_EVENT]);
    assert.deepEqual(admin.deletedIds.slice().sort(), ["p-a", "p-b"]);
    assert.deepEqual(outcome.failed, []);
  });
});

/**
 * The behavioural tests above prove the SWEEPER is safe. They cannot prove that
 * rlsHardening actually uses it — and the defect was in that file's constants,
 * not in a helper. Reverting those three declarations to their unscoped form is
 * the exact mutation this guard refuses.
 */
describe("rlsHardening.test.ts uses run-scoped fixture labels", () => {
  const source = readFileSync(fileURLToPath(new URL("./rlsHardening.test.ts", import.meta.url)), "utf8");

  for (const decl of ["FIXTURE_HANDLES", "FIXTURE_EVENT_TITLE", "FIXTURE_TRIP_TITLE"]) {
    it(`${decl} is produced by fixtureLabel()`, () => {
      const match = source.match(new RegExp(`^const ${decl} = (.*)$`, "m"));
      assert.ok(match, `${decl} is no longer declared on one line in rlsHardening.test.ts`);
      assert.match(
        match[1],
        /fixtureLabel\(/,
        `${decl} is a deterministic constant again. Two concurrent live-DB runs will delete ` +
          `each other's rows, and this suite's 'RLS returned nothing' assertions will pass ` +
          `because the fixture is gone rather than because RLS hid it.`,
      );
    });
  }

  it("purgeFixtures sweeps through the shared decision, not a bare equality delete", () => {
    assert.match(
      source,
      /async function purgeFixtures[\s\S]*?purgeFixtureRowsDetailed/,
      "purgeFixtures no longer routes through purgeFixtureRowsDetailed; a bare " +
        "delete().eq(<unscoped constant>) takes a live peer's rows with it",
    );
  });
});
