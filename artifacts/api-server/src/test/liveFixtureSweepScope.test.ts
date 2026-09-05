/**
 * liveFixtureSweepScope — a fixture sweep must not delete another run's users.
 *
 * ── THE DEFECT, MEASURED 2026-09-05 ─────────────────────────────────────────
 * `matchesFixtureEmail(candidate, base)` accepts `stem+anything@domain`, and
 * `purgeFixtureUsersDetailed` deleted everything it accepted. `anything` is
 * another run's id. So the sweep in one run's `before` hook deleted every
 * CONCURRENT run's live fixture users, undoing precisely the isolation
 * `fixtureEmail()` had been introduced to provide.
 *
 * That is not a theory. Two attempts overlapped on the shared CI project
 * 13:17:56–13:23:12 that day, and three suites that were ALREADY run-scoped
 * (profile-role-not-self-writable, local-guide-self-promotion,
 * rbp-self-verification) went red with `readRole(<uuid>): Cannot coerce the
 * result to a single JSON object` — their own rows, deleted by a peer's sweep.
 *
 * ── WHAT THIS PROVES, AND WHY IT CAN PROVE IT WITHOUT A DATABASE ────────────
 * The decision is a pure function of (account, base emails, clock). The admin
 * client is a hand-written double whose only jobs are to hand back a user list
 * and to record which ids were deleted, so this runs in the ordinary `pnpm
 * test` tier — the tier that executes whatever the live database is doing, and
 * whatever credentials are or are not configured.
 *
 * NO credential env var is named in this file, deliberately — see
 * scripts/check-guard-coverage.mjs.
 *
 * ── MUTATION PROOF ─────────────────────────────────────────────────────────
 * Restoring the broad address-only match in `purgeFixtureUsersDetailed`:
 *
 *     const targets = users.filter((u) =>
 *       baseEmails.some((base) => matchesFixtureEmail(String(u?.email ?? ""), base)));
 *
 * turns "leaves a live peer's user alone" and "leaves an undatable account
 * alone" RED (the peer and the undatable account are both deleted) while every
 * other assertion here stays green. Restoring the real implementation returns
 * all of them to green. Recorded because a sweep test that passes under the
 * broken sweep is worth nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FIXTURE_RUN_ID,
  FIXTURE_SWEEP_MIN_AGE_MS,
  classifyFixtureEmail,
  fixtureEmail,
  isSweepableFixtureUser,
  purgeFixtureUsersDetailed,
  sweepMinAgeMs,
} from "./liveFixtureUsers.js";

const BASE = "sweepscope_probe_owner@example.com";
const OTHER_BASE = "sweepscope_probe_stranger@example.com";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

/** `stem+r<id>@domain` for an arbitrary run id — what a peer's address looks like. */
function addressOfRun(base: string, runId: string): string {
  const at = base.lastIndexOf("@");
  return `${base.slice(0, at).split("+")[0]}+r${runId}@${base.slice(at + 1)}`;
}

const PEER_RUN = "peerrun00001";
const DEAD_RUN = "deadrun99999";

describe("classifyFixtureEmail — whose address is this", () => {
  it("recognises THIS run's address as mine", () => {
    assert.equal(classifyFixtureEmail(fixtureEmail(BASE), BASE), "mine");
  });

  it("recognises another run's address as foreign, not as mine", () => {
    assert.equal(classifyFixtureEmail(addressOfRun(BASE, PEER_RUN), BASE), "foreign");
    // The bug this forbids: a run id that merely CONTAINS ours, or vice versa.
    assert.equal(classifyFixtureEmail(addressOfRun(BASE, `${FIXTURE_RUN_ID}x`), BASE), "foreign");
    assert.equal(classifyFixtureEmail(addressOfRun(BASE, `x${FIXTURE_RUN_ID}`), BASE), "foreign");
  });

  it("recognises a pre-run-scoping address as unscoped", () => {
    assert.equal(classifyFixtureEmail(BASE, BASE), "unscoped");
  });

  it("still rejects everything that is not ours at all", () => {
    assert.equal(classifyFixtureEmail("sweepscope_probe_owner_two@example.com", BASE), null);
    assert.equal(classifyFixtureEmail("sweepscope_probe_owner@gmail.com", BASE), null);
    assert.equal(classifyFixtureEmail("", BASE), null);
  });
});

describe("isSweepableFixtureUser — the one delete decision", () => {
  const now = Date.now();
  const user = (email: string, ageMs: number | null) => ({
    id: email,
    email,
    ...(ageMs === null ? {} : { created_at: new Date(now - ageMs).toISOString() }),
  });

  it("sweeps THIS run's user at any age — that is the teardown path", () => {
    assert.equal(isSweepableFixtureUser(user(fixtureEmail(BASE), 0), [BASE], now), true);
    assert.equal(isSweepableFixtureUser(user(fixtureEmail(BASE), 5 * HOUR), [BASE], now), true);
  });

  it("REFUSES a live peer's user — the 2026-09-05 defect", () => {
    assert.equal(
      isSweepableFixtureUser(user(addressOfRun(BASE, PEER_RUN), 30_000), [BASE], now),
      false,
      "a fixture account created 30 seconds ago belongs to a run that is still using it",
    );
  });

  it("sweeps a genuinely stranded user from a dead run", () => {
    assert.equal(
      isSweepableFixtureUser(user(addressOfRun(BASE, DEAD_RUN), 6 * HOUR), [BASE], now),
      true,
      "if this stops being true the 56-orphaned-user problem returns",
    );
  });

  it("sweeps an old pre-run-scoping address and spares a fresh one", () => {
    assert.equal(isSweepableFixtureUser(user(BASE, 6 * HOUR), [BASE], now), true);
    assert.equal(isSweepableFixtureUser(user(BASE, 30_000), [BASE], now), false);
  });

  it("refuses an account whose age it cannot determine", () => {
    // "I could not tell how old it is" is not "it is old".
    assert.equal(isSweepableFixtureUser(user(addressOfRun(BASE, DEAD_RUN), null), [BASE], now), false);
    assert.equal(
      isSweepableFixtureUser({ id: "x", email: addressOfRun(BASE, DEAD_RUN), created_at: "not a date" }, [BASE], now),
      false,
    );
  });

  it("never sweeps an address that is not a fixture address of ours", () => {
    assert.equal(isSweepableFixtureUser(user("someone@gmail.com", 9 * HOUR), [BASE], now), false);
    assert.equal(isSweepableFixtureUser(user("sweepscope_probe_owner_two@example.com", 9 * HOUR), [BASE], now), false);
  });

  it("uses an age threshold that outlasts the longest live-DB job", () => {
    // live-db.yml caps its DB jobs at 45 minutes, slot re-verification
    // included, and fixture accounts are created after that. A threshold below
    // that bound would still race a slow peer.
    assert.ok(
      FIXTURE_SWEEP_MIN_AGE_MS >= 60 * MINUTE,
      `the peer-protection window is ${FIXTURE_SWEEP_MIN_AGE_MS}ms, which is shorter than a live-DB job may run`,
    );
  });
});

/**
 * A minimal admin double. `listUsers` pages the way GoTrue does (the purge stops
 * on an EMPTY page, never a short one) and `deleteUser` records the id.
 */
function fakeAdmin(users: Array<Record<string, unknown>>) {
  const deleted: string[] = [];
  const profilesDeleted: string[] = [];
  return {
    deleted,
    profilesDeleted,
    auth: {
      admin: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        listUsers: async ({ page }: any) => ({
          data: { users: page === 1 ? users.filter((u) => !deleted.includes(String(u.id))) : [] },
          error: null,
        }),
        deleteUser: async (id: string) => {
          deleted.push(id);
          return { error: null };
        },
      },
    },
    from: (_table: string) => ({
      delete: () => ({
        eq: async (_col: string, id: string) => {
          profilesDeleted.push(id);
          return { error: null };
        },
      }),
    }),
  };
}

describe("purgeFixtureUsersDetailed — a sweep by run A must not touch run B", () => {
  const HOURS_6 = 6 * HOUR;

  const MINE = fixtureEmail(BASE);
  const PEER = addressOfRun(BASE, PEER_RUN);
  const PEER_OTHER = addressOfRun(OTHER_BASE, PEER_RUN);
  const STRANDED = addressOfRun(BASE, DEAD_RUN);
  const LEGACY_OLD = OTHER_BASE;
  const UNRELATED = "sweepscope_probe_owner_two@example.com";

  const roster = () => [
    { id: "u-mine", email: MINE, created_at: iso(2_000) },
    { id: "u-peer", email: PEER, created_at: iso(30_000) },
    { id: "u-peer-other", email: PEER_OTHER, created_at: iso(90_000) },
    { id: "u-stranded", email: STRANDED, created_at: iso(HOURS_6) },
    { id: "u-legacy-old", email: LEGACY_OLD, created_at: iso(HOURS_6) },
    { id: "u-unrelated", email: UNRELATED, created_at: iso(HOURS_6) },
    { id: "u-undatable", email: addressOfRun(BASE, "undatable01") },
  ];

  it("deletes this run's own user, and the stranded ones, and nothing else", async () => {
    const admin = fakeAdmin(roster());
    const outcome = await purgeFixtureUsersDetailed(admin, [BASE, OTHER_BASE]);

    assert.deepEqual(outcome.failed, [], "no delete should have been refused by the double");
    assert.deepEqual(
      admin.deleted.sort(),
      ["u-legacy-old", "u-mine", "u-stranded"],
      "the sweep must take exactly: this run's own fixture, a stranded run-scoped leftover, " +
        "and an old pre-run-scoping address",
    );
  });

  it("LEAVES A CONCURRENT RUN'S USERS ALONE — the regression this file exists for", async () => {
    const admin = fakeAdmin(roster());
    await purgeFixtureUsersDetailed(admin, [BASE, OTHER_BASE]);

    assert.ok(
      !admin.deleted.includes("u-peer"),
      "the sweep deleted a live concurrent run's fixture user. That is the 2026-09-05 defect: " +
        "run A's before-hook sweep removed run B's accounts mid-suite and five suites went red " +
        "on correct code.",
    );
    assert.ok(!admin.deleted.includes("u-peer-other"), "a peer's SECOND fixture user was deleted too");
    assert.ok(!admin.deleted.includes("u-undatable"), "an account of unknown age was deleted");
    assert.ok(!admin.deleted.includes("u-unrelated"), "an address that is not ours was deleted");
  });

  it("still sweeps genuinely stranded fixtures — the sweep must not become inert", async () => {
    // Deleting nothing would also pass the assertion above. It is not a fix.
    const admin = fakeAdmin(roster());
    await purgeFixtureUsersDetailed(admin, [BASE, OTHER_BASE]);
    assert.ok(admin.deleted.includes("u-stranded"), "the orphan sweep stopped working");
    assert.ok(admin.deleted.length >= 3, "a sweep that deletes (almost) nothing lets orphans accumulate");
  });

  it("removes the profiles row before the auth user, for each account it takes", async () => {
    const admin = fakeAdmin(roster());
    await purgeFixtureUsersDetailed(admin, [BASE, OTHER_BASE]);
    assert.deepEqual(admin.profilesDeleted.sort(), admin.deleted.slice().sort());
  });
});

describe("the age threshold is configurable, and every bad value falls back to the safe one", () => {
  it("defaults to two hours when the override is absent or unusable", () => {
    assert.equal(sweepMinAgeMs(undefined), 120 * 60_000);
    assert.equal(sweepMinAgeMs(""), 120 * 60_000, "an empty value must not read as zero — a zero window sweeps live peers");
    assert.equal(sweepMinAgeMs("   "), 120 * 60_000);
    assert.equal(sweepMinAgeMs("not a number"), 120 * 60_000);
    assert.equal(sweepMinAgeMs("0"), 120 * 60_000, "zero minutes IS the original defect, spelled as configuration");
    assert.equal(sweepMinAgeMs("-5"), 120 * 60_000);
  });

  it("honours a deliberate override", () => {
    assert.equal(sweepMinAgeMs("30"), 30 * 60_000);
    assert.equal(sweepMinAgeMs(" 90 "), 90 * 60_000);
  });
});
