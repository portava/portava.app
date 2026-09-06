/**
 * §12 "What Portava Remembers" — Group 6, consented Shared Moments.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `buildSharedMoments` selected `shared_moments.visibility`. That column does
 * not exist — not in the baseline dump, not in production (verified
 * 2026-09-05), not in any migration. PostgREST fails the WHOLE query on an
 * unknown select-list column, so `moments` came back null, `asRows` produced
 * [], and Group 6 of the owner's transparency surface silently produced nothing
 * — for every user, always. `safe()` swallowed it.
 *
 * The existing passport fake (`helpers/fakePassportDb`) cannot catch this: its
 * `.select()` ignores the column list entirely, so a query naming a phantom
 * column reads as a perfectly healthy one. THAT is why this defect survived a
 * tested service. So this file drives a STRICT fake that rejects an unknown
 * column exactly as PostgREST does, with the column sets taken from the real
 * schema.
 *
 * MUTATION PROOF. Put `visibility` back into the select list in
 * `buildSharedMoments` and every test here goes RED (the strict client raises
 * 42703 and the group returns empty).
 *
 * Run: node --import tsx/esm --test src/test/passportRemembersSharedMoments.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSharedMoments,
  sharedMomentVisibility,
} from "../compass/PassportRemembersService.js";
import { projectionKeys, projectRow } from "./helpers/selectProjection.js";

const OWNER = "5m0000000-0000-0000-0000-0000000000o1";
const STRANGER = "5m0000000-0000-0000-0000-0000000000s1";

/** The real column sets, from baseline/20260819_baseline_structure.sql. */
const SCHEMA: Record<string, string[]> = {
  shared_moments: [
    "id", "owner_id", "place_day_id", "place_id", "trip_id", "title",
    "description", "join_policy", "status", "archived_at", "created_at",
    "updated_at",
  ],
  shared_moment_memberships: [
    "id", "moment_id", "user_id", "role", "status", "invited_by",
    "responded_at", "removed_at", "created_at", "updated_at",
  ],
};

type Row = Record<string, any>;

/**
 * A supabase-js surface that behaves like PostgREST on an unknown select-list
 * column: the whole query fails (42703) and `data` is null.
 *
 * It ALSO projects the select list, via the shared projector (#436) rather than
 * a private copy of the rule. Without that this file's own header claim — that
 * putting `visibility` back in the select turns every test here RED — was FALSE:
 * measured 5/5 green with the production select stripped of `join_policy` while
 * the mapper still read it. Rejecting an unknown column and returning only the
 * KNOWN ones are two different properties, and only the first was implemented.
 */
function strictDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const store: Row[] = tables[table] ?? [];
      const known = SCHEMA[table];
      const filters: Array<(r: Row) => boolean> = [];
      let bad: string | null = null;
      let limitN: number | null = null;
      // `null` = do not project (see selectProjection.ts for the bail rules).
      let projection: Array<[string, string]> | null = null;

      const builder: any = {
        select(fields?: string) {
          if (known && typeof fields === "string") {
            for (const raw of fields.split(",")) {
              const col = raw.trim().split(":").pop()!.trim();
              if (col && col !== "*" && !known.includes(col)) bad = col;
            }
          }
          projection = projectionKeys(fields);
          return builder;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        limit(n: number) { limitN = n; return builder; },
        order() { return builder; },
        then(onF: any, onR: any) {
          if (bad) {
            return Promise.resolve({
              data: null,
              error: { code: "42703", message: `column ${table}.${bad} does not exist` },
            }).then(onF, onR);
          }
          let rows = store.filter((r) => filters.every((f) => f(r)));
          if (limitN !== null) rows = rows.slice(0, limitN);
          // Narrow on the way OUT only — the database filters on the full row.
          const out = projection ? rows.map((r) => projectRow(r, projection!) as Row) : rows;
          return Promise.resolve({ data: out, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  } as any;
}

const MOMENTS: Row[] = [
  // Accepted by OWNER — must appear.
  { id: "m-accepted", owner_id: STRANGER, title: "Sunset at My Khe", status: "active", join_policy: "invite_only", archived_at: null, created_at: "2026-03-01T00:00:00Z" },
  // Accepted by OWNER but archived — excluded by the archive rule.
  { id: "m-archived", owner_id: STRANGER, title: "Old plan", status: "archived", join_policy: "invite_only", archived_at: "2026-02-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
  // Approval-required policy, accepted — must appear, labelled participants_only.
  { id: "m-approval", owner_id: OWNER, title: "Hoi An food crawl", status: "active", join_policy: "approval_required", archived_at: null, created_at: "2026-03-02T00:00:00Z" },
  // NOT consented by OWNER (invited, never accepted) — must never appear.
  { id: "m-invited", owner_id: STRANGER, title: "Somebody else's night out", status: "active", join_policy: "invite_only", archived_at: null, created_at: "2026-03-03T00:00:00Z" },
];

function memberships(ownerStatusForInvited: string) {
  return [
    { id: "b1", moment_id: "m-accepted", user_id: OWNER, role: "member", status: "accepted", removed_at: null, created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" },
    { id: "b2", moment_id: "m-archived", user_id: OWNER, role: "member", status: "accepted", removed_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "b3", moment_id: "m-approval", user_id: OWNER, role: "owner", status: "accepted", removed_at: null, created_at: "2026-03-02T00:00:00Z", updated_at: "2026-03-02T00:00:00Z" },
    // The consent-gate subject. "invited" in the real case; the positive
    // control flips it to "accepted".
    { id: "b4", moment_id: "m-invited", user_id: OWNER, role: "member", status: ownerStatusForInvited, removed_at: null, created_at: "2026-03-03T00:00:00Z", updated_at: "2026-03-03T00:00:00Z" },
    // A stranger's accepted membership in the same moment — proves the
    // user_id filter, not the status filter, is what keeps it out for OWNER.
    { id: "b5", moment_id: "m-invited", user_id: STRANGER, role: "member", status: "accepted", removed_at: null, created_at: "2026-03-03T00:00:00Z", updated_at: "2026-03-03T00:00:00Z" },
  ];
}

describe("Passport Remembers — Group 6 shared moments (strict schema)", () => {
  it("surfaces the owner's consented, active moments (the query no longer dies whole)", async () => {
    const db = strictDb({ shared_moments: MOMENTS, shared_moment_memberships: memberships("invited") });
    const items = await buildSharedMoments(db, OWNER);

    const ids = items.map((i) => i.source.originId).sort();
    assert.deepEqual(
      ids,
      ["m-accepted", "m-approval"],
      "Group 6 must produce the two accepted, active moments — an empty array here " +
        "means the select named a column the table does not have and PostgREST " +
        "failed the whole read (the pre-fix behaviour).",
    );
    assert.equal(items[0].group, "shared_moment");
    assert.ok(items.every((i) => i.source.originTable === "shared_moments"));
  });

  it("labels every moment participants-only — a shared moment is never public", async () => {
    const db = strictDb({ shared_moments: MOMENTS, shared_moment_memberships: memberships("invited") });
    const items = await buildSharedMoments(db, OWNER);
    assert.ok(items.length > 0);
    for (const i of items) {
      assert.equal(i.visibility, "participants_only", `${i.source.originId} mislabelled`);
    }
    // Fail-closed on anything the schema does not permit.
    assert.equal(sharedMomentVisibility("invite_only"), "participants_only");
    assert.equal(sharedMomentVisibility("approval_required"), "participants_only");
    assert.equal(sharedMomentVisibility("public"), "private", "an unknown policy must read as MORE private");
    assert.equal(sharedMomentVisibility(null), "private");
    assert.equal(sharedMomentVisibility(undefined), "private");
  });

  it("excludes an archived moment even though the owner consented to it", async () => {
    const db = strictDb({ shared_moments: MOMENTS, shared_moment_memberships: memberships("invited") });
    const items = await buildSharedMoments(db, OWNER);
    assert.ok(!items.some((i) => i.source.originId === "m-archived"));
  });

  // ── The consent gate, with a positive control ─────────────────────────────
  //
  // "m-invited" is active, un-archived and present in the moments table, so
  // nothing but the consent gate can be excluding it. The control proves that:
  // flip the SAME row's membership status to 'accepted' and it appears.

  it("omits a moment the owner has NOT accepted — and the positive control proves the consent gate is why", async () => {
    const denied = await buildSharedMoments(
      strictDb({ shared_moments: MOMENTS, shared_moment_memberships: memberships("invited") }),
      OWNER,
    );
    assert.ok(
      !denied.some((i) => i.source.originId === "m-invited"),
      "an un-accepted moment must never reach the owner's remembers surface",
    );

    // POSITIVE CONTROL — identical fixture, one field changed.
    const allowed = await buildSharedMoments(
      strictDb({ shared_moments: MOMENTS, shared_moment_memberships: memberships("accepted") }),
      OWNER,
    );
    assert.ok(
      allowed.some((i) => i.source.originId === "m-invited"),
      "control failed: 'm-invited' stays out even WITH consent, so the first " +
        "assertion proved nothing about the consent gate",
    );
  });

  it("never surfaces a moment on a stranger's consent", async () => {
    // OWNER has no membership row at all here; STRANGER's accepted membership
    // must not carry the moment across.
    const db = strictDb({
      shared_moments: MOMENTS,
      shared_moment_memberships: [
        { id: "b5", moment_id: "m-accepted", user_id: STRANGER, role: "member", status: "accepted", removed_at: null, created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" },
      ],
    });
    assert.deepEqual(await buildSharedMoments(db, OWNER), []);

    // POSITIVE CONTROL: the same moment IS reachable for the user who consented.
    const forStranger = await buildSharedMoments(db, STRANGER);
    assert.ok(
      forStranger.some((i) => i.source.originId === "m-accepted"),
      "control failed: the moment is unreachable for everyone, so the first " +
        "assertion proved nothing about the user filter",
    );
  });
});
