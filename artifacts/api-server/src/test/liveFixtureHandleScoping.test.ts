/**
 * liveFixtureHandleScoping — the last identifier two live runs still shared.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * PR #421 run-scoped the live suites' auth users (`stem+r<run id>@domain`), and
 * the row-scoping change on the parent branch did the same for rlsHardening's
 * trips/events/profiles rows. Twenty-two other live suites were left creating
 * their profile rows like this:
 *
 *     await sc.from("profiles").upsert(
 *       { id, handle: `${PREFIX}${tag}`, username: `${PREFIX}${tag}`, … },
 *       { onConflict: "id" },
 *     );
 *
 * `profiles_handle_key` is UNIQUE (baseline/20260819_baseline_structure.sql),
 * and so is `profiles_username_lower_unique` — `lower(username)` WHERE username
 * IS NOT NULL, recorded twice under two names. The `onConflict: "id"` clause
 * resolves a conflict on the PRIMARY KEY and on nothing else.
 *
 * Because every run now creates a DIFFERENT auth user, the two runs' upserts
 * carry two different ids and the same handle. The second one is therefore an
 * INSERT, not an update, and Postgres rejects it 23505. Run-scoping the emails
 * without run-scoping the handle turned a silent overwrite into a hard failure:
 * the id was the only thing that used to differ, and now it is the only thing
 * that still collides through.
 *
 * `geoZoneWriteBoundary.test.ts` carried the worse half of the same bug. Its
 * zones were named by constants and its `after` hook ran
 *
 *     await sc.from("geo_zones").delete().like("name", `${PREFIX}%`);
 *
 * which matches EVERY run's zones. Run A's teardown deleted run B's live rows
 * mid-suite. A 23505 stops a run loudly; a peer-delete corrupts it silently —
 * B's remaining assertions read a table its fixtures have been removed from.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 * One scheme, already built, reused unchanged: `fixtureLabel(base)` appends
 * `_r<FIXTURE_RUN_ID>`, and `purgeFixtureRowsDetailed` routes every candidate
 * through `decideSweep` — mine at any age (that is the teardown path), a peer's
 * only once it is older than any live run could be. Nothing about the rule is
 * re-expressed here; this file imports it. A second copy of "may I delete this"
 * is precisely how the defect reached a third table.
 *
 * ── THE COLUMN ACCEPTS THE SCOPED VALUE (checked, not assumed) ──────────────
 *   • `profiles.handle` is `text NOT NULL`, `profiles.username` is `text`.
 *     Neither has a length cap or a CHECK constraint, in the baseline or in any
 *     later migration, so `_r<10 hex>` cannot overflow the column.
 *   • The only format rule in the codebase is `USERNAME_RE = /^[a-z0-9_]{3,30}/`
 *     in `src/lib/usernameRules.ts`. It is reached from `routes/profile.ts` and
 *     the input-assistance gateway — HTTP write paths. These fixtures are
 *     service-role PostgREST upserts and traverse neither. It is also already
 *     exceeded WITHOUT this change: `is_official_guard_test_official` is 31
 *     characters, and that suite is green. So the cap is not a runtime gate on
 *     this path, and shortening the run token for handles alone would have
 *     bought nothing at the price of a second, divergent scoping scheme.
 *   • What DOES matter is the charset, and it is asserted below: `_r` + hex
 *     keeps a scoped label inside `[a-z0-9_]`, so no scoped handle can start
 *     failing a charset rule that an unscoped one passed.
 *
 * ── WHAT THIS FILE PROVES, WITHOUT A DATABASE ───────────────────────────────
 * Two behavioural proofs against doubles — a `geo_zones` sweep, and a
 * `profiles` table that enforces the two unique indexes the real one has — plus
 * source guards, because the defect lives in the SUITES' literals and a helper
 * that is correct but unused fixes nothing.
 *
 * Each behavioural proof has a peer-protection half AND a not-inert half. A
 * sweep that deletes nothing leaves every peer alone and is not a fix; an
 * insert double that never raises 23505 accepts every colliding handle and
 * proves nothing.
 *
 * NO credential env var is named in this file, deliberately — see
 * scripts/check-guard-coverage.mjs.
 *
 * ── MUTATION PROOF ─────────────────────────────────────────────────────────
 * Each mutation was applied, observed RED, and reverted to GREEN:
 *
 *   (a) THE UNSCOPED LITERAL. In geoZoneWriteBoundary.test.ts restore
 *           const Z_MAIN = `${PREFIX}zone`;                    (drop fixtureLabel)
 *       → "every live suite writes profiles.handle through fixtureLabel()" /
 *         the geo_zones source guard go RED.
 *   (b) THE BROAD `.like()` DELETE. In geoZoneWriteBoundary.test.ts restore
 *           await sc.from(TABLE).delete().like("name", `${PREFIX}%`);
 *       → "geoZoneWriteBoundary sweeps through the shared decision" goes RED.
 *   (c) THE SCHEME ITSELF. In liveFixtureUsers.ts make `fixtureLabel` return
 *       `base` unchanged
 *       → the peer-protection sweep assertions and the 23505 collision proof go
 *         RED; the not-inert assertions stay green, which is the point of
 *         having both.
 *
 * Run: node --import tsx/esm --test src/test/liveFixtureHandleScoping.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_RUN_ID,
  classifyFixtureLabel,
  fixtureLabel,
  purgeFixtureRowsDetailed,
} from "./liveFixtureUsers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const PEER_RUN = "peerrun00001";
const DEAD_RUN = "deadrun99999";

/** `<base>_r<id>` for an arbitrary run — what another run's label looks like. */
function labelOfRun(base: string, runId: string): string {
  return `${base}_r${runId}`;
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function readTest(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// The twenty-two live suites that wrote an unscoped profiles.handle.
// ─────────────────────────────────────────────────────────────────────────────
const HANDLE_SUITES = [
  "buddyServiceApprovalBoundary.test.ts",
  "compassMemoryClientBoundary.test.ts",
  "discoveryPlaceWriteBoundary.test.ts",
  "geoZoneWriteBoundary.test.ts",
  "hiddenGemSelfPublish.test.ts",
  "hiddenGemVisitTrustBoundary.test.ts",
  "isOfficialPrivileged.test.ts",
  "localGuideSelfPromotion.test.ts",
  "passportMemorySelfVerification.test.ts",
  "passportPostcardLocationVerification.test.ts",
  "passportPostcardStatusModeration.test.ts",
  "passportStampSelfVerification.test.ts",
  "portavaFeaturedWriteBoundary.test.ts",
  "postLocationVerificationBoundary.test.ts",
  "postMediaModerationBoundary.test.ts",
  "profileRoleNotSelfWritable.test.ts",
  "profileVerificationSelfWriteBoundary.test.ts",
  "publicProfileVerificationViewBoundary.test.ts",
  "rentBuddyAddonApprovalBoundary.test.ts",
  "rentBuddyApplicationSelfApproval.test.ts",
  "rentBuddyPackageReviewBoundary.test.ts",
  "rentBuddyProfileSelfVerification.test.ts",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 1 — two runs' profile fixtures do not collide on the unique indexes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `profiles` double that enforces exactly the two uniqueness rules the real
 * table has, and nothing else:
 *
 *   • `profiles_handle_key`            UNIQUE (handle)             — verbatim
 *   • `profiles_username_lower_unique` UNIQUE (lower(username))    — folded
 *
 * `upsert(row, { onConflict: "id" })` updates in place when the id is already
 * present and otherwise INSERTS — which is the behaviour that makes the shared
 * handle fatal rather than merely wasteful, because two runs create two
 * different auth users and therefore two different ids.
 *
 * It RAISES 23505 rather than returning a flag, so a test that expects no
 * collision cannot pass by the double having quietly accepted everything.
 */
function profilesTable() {
  const rows = new Map<string, { id: string; handle: string; username: string | null }>();
  return {
    rows,
    upsertOnId(row: { id: string; handle: string; username?: string | null }): void {
      const username = row.username ?? null;
      for (const [id, existing] of rows) {
        if (id === row.id) continue;
        if (existing.handle === row.handle) {
          throw new Error(`23505: duplicate key value violates unique constraint "profiles_handle_key" (${row.handle})`);
        }
        if (
          username !== null &&
          existing.username !== null &&
          existing.username.toLowerCase() === username.toLowerCase()
        ) {
          throw new Error(
            `23505: duplicate key value violates unique constraint "profiles_username_lower_unique" (${username})`,
          );
        }
      }
      rows.set(row.id, { id: row.id, handle: row.handle, username });
    },
  };
}

describe("profiles.handle — two concurrent runs must not collide", () => {
  const BASE = "buddy_svc_test_owner";

  it("the double actually enforces the unique indexes — the not-inert half", () => {
    // If this does not throw, every assertion below is vacuous: the double
    // would accept a colliding handle and "no collision" would prove nothing.
    const t = profilesTable();
    t.upsertOnId({ id: "run-a-user", handle: BASE, username: BASE });
    assert.throws(
      () => t.upsertOnId({ id: "run-b-user", handle: BASE, username: BASE }),
      /23505.*profiles_handle_key/,
      "the profiles double no longer rejects a duplicate handle, so this file proves nothing",
    );

    // The username index folds case; the handle index does not. Both must bite.
    const u = profilesTable();
    u.upsertOnId({ id: "run-a-user", handle: `${BASE}_x`, username: BASE });
    assert.throws(
      () => u.upsertOnId({ id: "run-b-user", handle: `${BASE}_y`, username: BASE.toUpperCase() }),
      /23505.*profiles_username_lower_unique/,
      "username is UNIQUE on lower(username) and the double must reflect that",
    );
  });

  it("UNSCOPED handles are exactly what fails — this is the defect, reproduced", () => {
    // Pre-fix, both runs wrote the identical literal `${PREFIX}${tag}` under
    // different auth-user ids. onConflict:"id" does not resolve a handle
    // conflict, so run B inserts and Postgres refuses.
    const t = profilesTable();
    t.upsertOnId({ id: "run-a-user", handle: BASE, username: BASE });
    assert.throws(
      () => t.upsertOnId({ id: "run-b-user", handle: BASE, username: BASE }),
      /23505/,
      "if this stops throwing, the collision this commit fixes was never real",
    );
  });

  it("RUN-SCOPED handles let both runs create their fixture — the fix", () => {
    const mine = fixtureLabel(BASE);

    // The load-bearing half. This process cannot run itself twice under two run
    // ids, so the oracle for "would another run have produced this same string"
    // is the classifier: a label that reads back as `unscoped` carries no run
    // id, which means EVERY run produces it and the second insert is the 23505
    // above. Asking classifyFixtureLabel keeps the scheme in one place.
    assert.equal(
      classifyFixtureLabel(mine, BASE),
      "mine",
      "fixtureLabel returned a label with no run id in it, so every concurrent run writes the " +
        "identical handle and the second one fails 23505 on profiles_handle_key",
    );
    assert.notEqual(mine, BASE);

    const t = profilesTable();
    t.upsertOnId({ id: "run-a-user", handle: mine, username: mine });
    assert.doesNotThrow(
      () => t.upsertOnId({ id: "run-b-user", handle: labelOfRun(BASE, PEER_RUN), username: labelOfRun(BASE, PEER_RUN) }),
      "a concurrent run's scoped handle collided; the scoping scheme is not doing its job",
    );
    assert.equal(t.rows.size, 2, "both runs' fixture profiles must exist side by side");
  });

  it("a run's own re-upsert still resolves on the primary key", () => {
    // The scoping must not break the case onConflict:"id" exists for — the same
    // run writing its own profile twice (a retried before-hook, say).
    const t = profilesTable();
    t.upsertOnId({ id: "run-a-user", handle: fixtureLabel(BASE), username: fixtureLabel(BASE) });
    assert.doesNotThrow(() =>
      t.upsertOnId({ id: "run-a-user", handle: fixtureLabel(BASE), username: fixtureLabel(BASE) }),
    );
    assert.equal(t.rows.size, 1);
  });

  it("the scoped label stays inside the handle/username charset", () => {
    // `profiles.handle`/`username` are plain `text` with no cap and no CHECK, so
    // length cannot fail. The charset is the property worth pinning: `_r` + hex
    // keeps a scoped label in [a-z0-9_], the same alphabet the unscoped one was
    // already in, so scoping cannot make a fixture newly invalid anywhere.
    assert.match(fixtureLabel(BASE), /^[a-z0-9_]+$/);
    assert.match(FIXTURE_RUN_ID, /^[a-z0-9]+$/, "a run id outside [a-z0-9] would leak into every label");
    assert.equal(classifyFixtureLabel(fixtureLabel(BASE), BASE), "mine");
    assert.equal(classifyFixtureLabel(labelOfRun(BASE, PEER_RUN), BASE), "foreign");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 2 — the geo_zones sweep must not delete a peer's rows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A minimal admin double for `purgeFixtureRowsDetailed`.
 *
 * Scaffolding only: the DECISION is imported from liveFixtureUsers, never
 * restated here. `select(...).like(col, pattern)` reproduces SQL LIKE
 * semantics including `_` as a single-character wildcard — the reason the
 * sweeper treats its prefilter as a candidate list rather than a delete list —
 * and `delete().eq("id", …)` records what was taken.
 */
function fakeAdmin(tables: Record<string, Array<Record<string, unknown>>>) {
  const deletedIds: string[] = [];
  const likeToRegExp = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`);

  return {
    deletedIds,
    remaining: (table: string) => (tables[table] ?? []).map((r) => String(r.id)),
    from(table: string) {
      return {
        select: (_cols: string) => ({
          like: async (col: string, pattern: string) => ({
            data: (tables[table] ?? []).filter((r) => typeof r[col] === "string" && likeToRegExp(pattern).test(r[col] as string)),
            error: null,
          }),
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

describe("geo_zones sweep — run A's teardown must not delete run B's zones", () => {
  const PREFIX = "geo_zone_test_";
  const BASES = [`${PREFIX}zone`, `${PREFIX}system`];

  const zones = () => [
    { id: "z-mine", name: fixtureLabel(`${PREFIX}zone`), created_at: iso(2_000) },
    { id: "z-mine-sys", name: fixtureLabel(`${PREFIX}system`), created_at: iso(2_000) },
    { id: "z-peer", name: labelOfRun(`${PREFIX}zone`, PEER_RUN), created_at: iso(30_000) },
    { id: "z-peer-sys", name: labelOfRun(`${PREFIX}system`, PEER_RUN), created_at: iso(90_000) },
    { id: "z-stranded", name: labelOfRun(`${PREFIX}zone`, DEAD_RUN), created_at: iso(6 * HOUR) },
    { id: "z-legacy-old", name: `${PREFIX}zone`, created_at: iso(6 * HOUR) },
    { id: "z-undatable", name: labelOfRun(`${PREFIX}system`, "undatable01") },
    // A real geo zone. The suite must never be able to reach one.
    { id: "z-real", name: "Da Nang", created_at: iso(9 * HOUR) },
  ];

  it("LEAVES A CONCURRENT RUN'S ZONES ALONE — the regression this file exists for", async () => {
    const admin = fakeAdmin({ geo_zones: zones() });
    await purgeFixtureRowsDetailed(admin, "geo_zones", "name", BASES);

    assert.ok(
      !admin.deletedIds.includes("z-peer"),
      "the sweep deleted a live concurrent run's geo zone. That is the defect: the old " +
        "`.delete().like(\"name\", `geo_zone_test_%`)` matched every run's zones, so run A's " +
        "after-hook removed run B's fixtures mid-suite and B's 'the zone must survive' " +
        "assertions failed for a reason unrelated to RLS.",
    );
    assert.ok(!admin.deletedIds.includes("z-peer-sys"), "a live peer's system zone was deleted");
    assert.ok(!admin.deletedIds.includes("z-undatable"), "a zone of unknown age was deleted");
    assert.ok(!admin.deletedIds.includes("z-real"), "a zone that is not a fixture was deleted");
    assert.ok(admin.remaining("geo_zones").includes("z-peer"), "the peer's zone must still be in the table");
  });

  it("still sweeps this run's own and genuinely stranded zones — the not-inert half", async () => {
    // Deleting NOTHING would satisfy the assertions above and is not a fix: the
    // `after` hook IS the teardown, and stranded zones would accumulate forever.
    const admin = fakeAdmin({ geo_zones: zones() });
    await purgeFixtureRowsDetailed(admin, "geo_zones", "name", BASES);

    assert.ok(admin.deletedIds.includes("z-mine"), "teardown of this run's own zone stopped working");
    assert.ok(admin.deletedIds.includes("z-mine-sys"), "teardown of this run's own system zone stopped working");
    assert.ok(admin.deletedIds.includes("z-stranded"), "the orphan sweep stopped working");
    assert.ok(admin.deletedIds.includes("z-legacy-old"), "an old pre-scoping zone was left behind forever");
    assert.ok(admin.deletedIds.length >= 4, "a sweep that deletes (almost) nothing lets orphans accumulate");
  });

  it("takes exactly the four it should, and reports what it spared", async () => {
    const admin = fakeAdmin({ geo_zones: zones() });
    const outcome = await purgeFixtureRowsDetailed(admin, "geo_zones", "name", BASES);

    assert.deepEqual(outcome.failed, [], "no delete should have been refused by the double");
    assert.deepEqual(
      admin.deletedIds.slice().sort(),
      ["z-legacy-old", "z-mine", "z-mine-sys", "z-stranded"],
      "the sweep must take exactly this run's two zones, one stranded leftover and one legacy row",
    );
    assert.ok(outcome.spared.includes(labelOfRun(`${PREFIX}zone`, PEER_RUN)));
    assert.ok(outcome.spared.includes(labelOfRun(`${PREFIX}system`, "undatable01")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE GUARDS — a correct helper that the suites do not call fixes nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The suite list is DERIVED FROM THE FILESYSTEM, not curated.
 *
 * It used to be a hand-written array of 22 names, pinned by
 * `assert.equal(new Set(HANDLE_SUITES).size, 22)`. That pin guards against a name
 * being silently DELETED from the list. It is blind to one that was never ADDED —
 * and on 2026-09-05 three live suites had never been added:
 * memoryLifecycleLive, memoryProjectionLifecycleLive and rlsHardening.
 *
 * The two memory suites were, at that moment, actually broken. They had been
 * run-scoped on the EMAIL (so every run mints a NEW auth-user id) while their
 * handle stayed the bare `${TAG}a`. Four leftover profiles stranded by a dead run
 * held those handles, so each new run's `profiles` upsert failed 23505, the error
 * was discarded, and the missing profile surfaced minutes later and a table away
 * as `insert or update on table "memory_projections" violates foreign key
 * constraint "memory_projections_user_fk"`. Main's live tier went red and stayed
 * red. A guard whose scope is a hand-written list cannot see the file nobody
 * thought to list.
 *
 * So: every test file that imports the live fixture helpers AND writes `profiles`
 * is in scope, automatically. `liveFixtureHandleScoping.test.ts` itself is the one
 * exclusion — it carries deliberately unscoped literals as its own test data.
 */
const HANDLE_SUITE_FLOOR = 25;

function derivedHandleSuites(): string[] {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts") && f !== "liveFixtureHandleScoping.test.ts")
    .filter((f) => {
      const s = readFileSync(`${dir}${f}`, "utf8");
      return s.includes("liveFixtureUsers.js") && /from\("profiles"\)/.test(s);
    })
    .sort();
}

describe("every live suite writes profiles.handle/username through fixtureLabel()", () => {
  const suites = derivedHandleSuites();

  it("derives its own scope, and the derivation cannot silently collapse", () => {
    // A derivation that returns nothing would make every assertion below vacuous:
    // zero suites, zero failures, green. The floor is what makes that impossible.
    assert.ok(
      suites.length >= HANDLE_SUITE_FLOOR,
      `only ${suites.length} live suites matched (floor ${HANDLE_SUITE_FLOOR}). Either the ` +
        `derivation broke, or suites were deleted. It must never be able to return an empty ` +
        `set and report success.`,
    );
    // The previously curated names must all still be in scope — the derivation is
    // allowed to grow, never to lose ground the hand-written list already held.
    const missing = HANDLE_SUITES.filter((f) => !suites.includes(f));
    assert.deepEqual(missing, [], "the derivation dropped suites the curated list covered");
  });

  for (const file of suites) {
    it(`${file} has no unscoped handle/username literal`, () => {
      const source = readTest(file);
      const unscoped = [...source.matchAll(/\b(handle|username): (`[^`]*`)/g)].map((m) => `${m[1]}: ${m[2]}`);
      assert.deepEqual(
        unscoped,
        [],
        `${file} writes a bare template literal into a UNIQUE column. profiles_handle_key and ` +
          `profiles_username_lower_unique are UNIQUE and onConflict:"id" does not resolve them, so a ` +
          `second concurrent run inserts the same handle under a different auth-user id and fails 23505. ` +
          `Wrap the value in fixtureLabel().`,
      );
      // The same literal, one indirection away: `ensureUser(EMAIL, `${TAG}a`)`.
      // This is the shape the two memory suites used, and it is why matching only
      // on `handle:` missed them even after they were in scope.
      const viaHelper = [...source.matchAll(/\bensureUser\([^,)]+,\s*(`[^`]*`)/g)].map((m) => m[1]);
      assert.deepEqual(
        viaHelper,
        [],
        `${file} passes a bare template literal as a handle argument. Scoping at the call site ` +
          `is fine, but the value must still go through fixtureLabel().`,
      );
      assert.match(
        source,
        /import \{[^}]*\bfixtureLabel\b[^}]*\} from "\.\/liveFixtureUsers\.js";/,
        `${file} must take fixtureLabel from the shared helper rather than rebuild the scheme`,
      );
      assert.match(
        source,
        /fixtureLabel\(/,
        `${file} imports fixtureLabel but never calls it — it no longer scopes anything`,
      );
    });
  }
});

describe("geoZoneWriteBoundary sweeps rows through the shared decision", () => {
  const source = readTest("geoZoneWriteBoundary.test.ts");

  it("has no prefix delete that would take a peer's zones", () => {
    // The mutation this refuses is restoring
    //   await sc.from(TABLE).delete().like("name", `${PREFIX}%`);
    // The doc comment above the fix quotes that line, so the guard looks for an
    // executable occurrence: a `.delete()` whose filter is a `like`.
    const executable = source
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(
      executable,
      /\.delete\(\)\s*\.like\(/,
      "geoZoneWriteBoundary deletes geo_zones by prefix again. That pattern matches every run's " +
        "zones, so this suite's teardown removes a live concurrent run's rows.",
    );
  });

  it("routes its row teardown through purgeFixtureRowsDetailed", () => {
    assert.match(
      source,
      /after\(async \(\) => \{[\s\S]*?purgeFixtureRowsDetailed\(/,
      "the after hook no longer sweeps through the shared decideSweep rule",
    );
  });

  it("names every zone it creates with fixtureLabel()", () => {
    for (const decl of ["Z_MAIN", "Z_SYSTEM", "Z_FORGED", "Z_VF", "Z_UPS", "Z_SVC"]) {
      const match = source.match(new RegExp(`^const ${decl} = (.*)$`, "m"));
      assert.ok(match, `${decl} is no longer declared on one line in geoZoneWriteBoundary.test.ts`);
      assert.match(
        match[1],
        /fixtureLabel\(/,
        `${decl} is a deterministic constant again — two runs will name the same zone and the ` +
          `sweep can no longer tell whose it is`,
      );
    }
    // And the sweeper is given the UNSCOPED bases; handing it scoped labels
    // would make the prefilter miss every stranded peer row.
    assert.match(source, /const ZONE_BASES = \[\s*`\$\{PREFIX\}/, "ZONE_BASES must hold unscoped bases");
  });
});
