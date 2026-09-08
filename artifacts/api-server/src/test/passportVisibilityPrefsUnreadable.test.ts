/**
 * passportVisibilityPrefsUnreadable — the owner's PRIVACY CHOICE must not be
 * manufactured out of a database hiccup.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `passport_visibility_preferences` carries the owner's collection-level tier
 * for their stamp shelf and their memories (`public | friends_only | private`).
 * `loadVisibilityPrefs` read it as:
 *
 *     const { data } = await sc.from("passport_visibility_preferences")…
 *     return (data as any) ?? null;          // error never bound
 *
 * supabase-js RESOLVES on a database error, so a FAILED read arrived as
 * `{ data: null, error }`, `?? null` flattened it onto the same `null` an
 * absent row produces, and `tierPermits(undefined, caller)` treats a missing
 * tier as the documented default — "public". The consequence is not a missing
 * feature, it is a LEAK: an owner who set `stamps_visible = 'private'` had
 * their shelf and their memories projected to a stranger, and the yearbook told
 * that stranger the owner had chosen to show them.
 *
 * The `try/catch` around the read never fired — nothing was thrown — and the
 * docblock above `loadCollectionVisibility` described the behaviour as
 * "fail-closed inputs" while the code did the opposite.
 *
 * ── HOW THIS IS MEASURED, NOT ASSUMED ───────────────────────────────────────
 * `makeFailClosedClient` injects the RESOLVED error shape, keyed on the exact
 * table, and never throws — a fake that threw would exercise a path production
 * never takes.
 *
 * WHAT ELSE COULD MAKE "the stranger sees no stamps" PASS? An empty fixture, a
 * viewer that fails an unrelated gate, or a per-stamp filter that hides the
 * seed anyway. So every degraded assertion here is paired with a HEALTHY
 * control on the SAME client seed and the SAME viewer that proves the stamp and
 * the memory DO reach that viewer when the preference row reads `public`
 * (test 1) — the fixture is provably capable of producing the leak. Test 2 is
 * the opposite control: a healthy `private` row must still hide them, so the
 * fix cannot be "hide always". Test 4 pins that the owner is not collateral
 * damage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import {
  buildPassportProjection,
  loadCollectionVisibility,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { buildYearbook } from "../services/passport/PassportYearbookService.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFS_TABLE = "passport_visibility_preferences";

const PUBLIC_PERMS: ViewerPermissions = {
  relationshipLabel: "none",
  isBlocked: false,
  isUnavailable: false,
  canViewProfile: true,
  canViewFullProfile: false,
  canSeeAvailability: false,
  canSeeTrips: false,
  canSeeMutuals: false,
  canSeeLocationContext: false,
  canSeeFriendOnlyPosts: false,
  canMessage: false,
  canSendMessageRequest: false,
  canFollow: true,
  canInviteToTripCrew: false,
};

const SELF_PERMS: ViewerPermissions = {
  ...PUBLIC_PERMS,
  relationshipLabel: "self",
  canViewFullProfile: true,
  canSeeAvailability: true,
  canSeeTrips: true,
  canSeeMutuals: true,
  canSeeLocationContext: true,
  canSeeFriendOnlyPosts: true,
  canFollow: false,
};

const PUBLIC_RESOLUTION: ViewerResolution = {
  context: "public",
  permissions: PUBLIC_PERMS,
  sharedTrip: false,
  sharedEvent: false,
  ownerIsTripHost: false,
  buddyRole: null,
};

const SELF_RESOLUTION: ViewerResolution = {
  context: "self",
  permissions: SELF_PERMS,
  sharedTrip: false,
  sharedEvent: false,
  ownerIsTripHost: false,
  buddyRole: null,
};

/** A PUBLIC stamp — so the per-stamp filter can never be what hides it. */
const A_STAMP = {
  id: "s1", user_id: OWNER, stamp_definition_id: "d1", source_type: "system",
  city: "Hanoi", country: "VN", earned_at: "2026-01-01T00:00:00Z",
  is_revoked: false, visibility: "public", catalog_id: null,
  stamp_definitions: {
    name: "First trip", rarity: "common", stamp_type: "trip",
    category: "trip", slug: "first_event_joined",
  },
};
const A_MEMORY = {
  id: "m1", user_id: OWNER, status: "active", title: "Hanoi", city: "Hanoi",
  country: "VN", category: "trip", visibility: "public",
  earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
};

const PROFILE = { id: OWNER, handle: "o", username: "o", verified: true };

/**
 * @param tier            what the preference row SAYS (null = no row at all)
 * @param failPrefsRead   make ONLY the preference read resolve an error
 */
function client(tier: string | null, failPrefsRead: boolean) {
  return makeFailClosedClient({
    rows: {
      profiles: [PROFILE],
      user_stamps: [A_STAMP],
      passport_stamps: [],
      passport_memories: [A_MEMORY],
      [PREFS_TABLE]: tier === null
        ? []
        : [{ user_id: OWNER, stamps_visible: tier, memories_visible: tier }],
    },
    // Keyed on the exact table AND the exact owner filter: nothing else in the
    // projection reads this table, so a green here cannot come from collateral
    // damage to a sibling read.
    failOn: (c) =>
      failPrefsRead && c.table === PREFS_TABLE && c.eq("user_id") === OWNER
        ? { message: "connection terminated unexpectedly", code: "57P01" }
        : null,
  });
}

const projOpts = (resolution: ViewerResolution) => ({
  profileRow: PROFILE as Record<string, any>,
  resolveViewerContext: async (): Promise<ViewerResolution> => resolution,
  crewSignal: "excluded" as const,
});

test("1. an unreadable preference row does not publish a PRIVATE shelf to a stranger", async () => {
  // ── Control: the very same client shape, healthy, with the tier set to
  //    'public'. This is what proves the fixture CAN produce the leak — without
  //    it, "the stranger saw no stamps" would pass on an empty shelf.
  const canLeak = await buildPassportProjection(
    client("public", false), OWNER, STRANGER, projOpts(PUBLIC_RESOLUTION),
  );
  assert.ok(canLeak, "the projection built");
  assert.equal(canLeak!.stamps.length, 1, "the seed reaches a stranger when the owner allows it");
  assert.equal(canLeak!.memories.length, 1, "…and so does the memory");
  assert.equal(canLeak!.unreadable, undefined, "a healthy read carries no degraded marker");

  // ── The defect: owner said PRIVATE, the preference read fails.
  const degraded = await buildPassportProjection(
    client("private", true), OWNER, STRANGER, projOpts(PUBLIC_RESOLUTION),
  );
  assert.ok(degraded, "the projection still builds — degraded, not absent");
  assert.deepEqual(
    degraded!.stamps, [],
    "an unreadable preference row must not be read as the owner consenting to 'public'",
  );
  assert.deepEqual(degraded!.memories, [], "…and the same for memories");

  // ── …and the withholding is NAMED, so the client cannot render it as
  //    "this traveller has no stamps".
  assert.ok(degraded!.unreadable, "a withheld-by-failure collection must say so");
  assert.deepEqual(
    [...degraded!.unreadable!].sort(), ["memories", "stamps"],
    "both withheld collections are named",
  );
});

test("2. a healthy 'private' row still hides — the fix is not 'hide always'", async () => {
  const p = await buildPassportProjection(
    client("private", false), OWNER, STRANGER, projOpts(PUBLIC_RESOLUTION),
  );
  assert.ok(p);
  assert.deepEqual(p!.stamps, [], "the owner's real choice is honoured");
  assert.deepEqual(p!.memories, []);
  // …and it is NOT reported as a read failure: the owner chose this.
  assert.equal(
    p!.unreadable, undefined,
    "a deliberate 'private' is a visibility answer, never an unreadable section",
  );
});

test("3. loadCollectionVisibility reports the refusal instead of inventing 'public'", async () => {
  const healthyAbsent = await loadCollectionVisibility(client(null, false), OWNER, "public");
  assert.deepEqual(
    { stamps: healthyAbsent.stamps, memories: healthyAbsent.memories },
    { stamps: true, memories: true },
    "no row at all IS the documented public default — that behaviour is preserved",
  );
  assert.notEqual(healthyAbsent.readFailed, true, "…and it is not a read failure");

  const broken = await loadCollectionVisibility(client(null, true), OWNER, "public");
  assert.deepEqual(
    { stamps: broken.stamps, memories: broken.memories },
    { stamps: false, memories: false },
    "an UNREADABLE row is not the same fact as an ABSENT row",
  );
  assert.equal(broken.readFailed, true, "and the caller is told which of the two it was");

  // The owner is never locked out of their own shelf by a failed preference read.
  const brokenOwner = await loadCollectionVisibility(client(null, true), OWNER, "owner");
  assert.deepEqual(
    { stamps: brokenOwner.stamps, memories: brokenOwner.memories },
    { stamps: true, memories: true },
    "the owner's own view does not consult the tier at all",
  );
});

test("4. the owner still sees their own shelf when the preference read fails", async () => {
  const own = await buildPassportProjection(
    client("private", true), OWNER, OWNER, projOpts(SELF_RESOLUTION),
  );
  assert.ok(own);
  assert.equal(own!.stamps.length, 1, "the degraded case must not cost the owner their passport");
  assert.equal(own!.memories.length, 1);
  assert.equal(
    own!.unreadable, undefined,
    "nothing was withheld from the owner, so nothing is marked unreadable for them",
  );
});

test("5. the yearbook says 'unavailable', not 'the owner hid it'", async () => {
  const perms = {
    isSelf: false,
    canSeeTrips: false,
    canSeeRestricted: false,
    callerCtx: "public" as const,
    viewerId: STRANGER,
  };

  // Control: healthy + public → the yearbook narrates the stamp.
  const healthy = await buildYearbook(client("public", false), OWNER, perms);
  const healthyStampExclusion = healthy.exclusions.find((e: any) => e.collection === "stamps");
  assert.equal(healthyStampExclusion, undefined, "a permitted collection is not excluded at all");

  // Healthy + private → excluded, and the reason is the owner's CHOICE.
  const chosen = await buildYearbook(client("private", false), OWNER, perms);
  assert.equal(
    chosen.exclusions.find((e: any) => e.collection === "stamps")?.reason, "visibility",
    "an owner who hid the shelf is reported as a visibility decision",
  );

  // Unreadable → excluded, and the reason is that the READ failed.
  const broken = await buildYearbook(client("private", true), OWNER, perms);
  assert.equal(
    broken.exclusions.find((e: any) => e.collection === "stamps")?.reason, "unavailable",
    "a failed preference read must never be narrated as the owner's decision",
  );
  assert.equal(
    broken.exclusions.find((e: any) => e.collection === "memories")?.reason, "unavailable",
  );
  // The two reasons must actually differ, or this test proves nothing.
  assert.notEqual("visibility", "unavailable");
});
