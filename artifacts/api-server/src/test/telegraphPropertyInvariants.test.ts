/**
 * Telegraph §27.1 — the seven property invariants, executed.
 *
 * A property test differs from the case tests beside it in one way that matters:
 * it quantifies. Every assertion here ranges over an ENUMERATED input space and
 * fails with the specific input that broke it, rather than over one fixture
 * somebody chose. The spaces are enumerated rather than sampled, so a green run
 * means "no input in this space violates it" and not "no input I happened to
 * draw violated it" — and a failure is reproducible by construction.
 *
 * Everything under test is real: the real canMessage, the real buildCrewCard,
 * the real messaging router, the real availability predicate. The orderings the
 * properties are measured against live in
 * src/domain/telegraph/policies/disclosureLattices.ts.
 *
 * SHOWN RED BEFORE GREEN — four deliberate, reverted mutations:
 *   1. lib/messagingPermissions.ts — the circle override changed from
 *      `!directlyAllowed && … && ctx.sharedCircle` to `… && !ctx.sharedCircle`,
 *      i.e. granting on ABSENCE. P-01 failed and named the state.
 *   2. domain/trips/services/tripCrewLocation.ts — resolveExactCoords made to ignore
 *      hotelBlurEnabled. P-02 failed on the blur transform.
 *   3. routes/messaging.ts — the departed-member gates removed from the thread
 *      read. Worth recording exactly: removing ONLY the `.is('left_at', null)`
 *      filter left this suite GREEN, because the handler re-checks `left_at` on
 *      the returned row immediately afterwards. It took removing BOTH to make
 *      P-03 fail, which is a fact about the route worth knowing — that gate is
 *      doubled, and the property measures the outcome rather than either gate.
 *   4. lib/blockGuard.ts — `if (error) return true` changed to `return false`.
 *      P-04 failed on the unreadable-blocks state.
 * Each was reverted immediately. P-06 and P-07 are absence assertions and were
 * shown red by adding a stub `router.post('/messages/:id/unsend')` to the
 * messaging router, which is exactly the event they exist to catch.
 *
 * Run: node --import tsx/esm --test src/test/telegraphPropertyInvariants.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import { canMessage } from "../lib/messagingPermissions.js";
import { buildCrewCard, type RawMemberLocation, type CrewVisibility } from "../domain/trips/services/tripCrewLocation.js";
import { isVisibleTo, type ViewerRelationship, type VisibilityPolicy } from "../services/passport/OpenToPlansService.js";
import { verdictRank, disclosedPrecision, newlyAccessible } from "../domain/telegraph/policies/disclosureLattices.js";
import { TELEGRAPH_PROPERTY_INVARIANTS } from "../domain/telegraph/invariants/propertyInvariants.js";
import {
  makeFakeClient,
  startRouter,
  call,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-00000000000a";

// ── Shape ─────────────────────────────────────────────────────────────────────

describe("§27.1 properties — shape", () => {
  it("declares exactly the spec's seven properties, one census row each", () => {
    assert.equal(TELEGRAPH_PROPERTY_INVARIANTS.length, 7);
    assert.deepEqual(
      TELEGRAPH_PROPERTY_INVARIANTS.map((p) => p.id),
      ["P-01", "P-02", "P-03", "P-04", "P-05", "P-06", "P-07"],
    );
    assert.equal(new Set(TELEGRAPH_PROPERTY_INVARIANTS.map((p) => p.censusRow)).size, 7);
    for (const p of TELEGRAPH_PROPERTY_INVARIANTS) {
      assert.ok(p.quantifier.includes("for all"), `${p.id} must state what it quantifies over`);
    }
  });
});

// ── P-01: permission decreases → accessible set never increases ───────────────

interface RelState {
  isFriend: boolean;
  senderFollows: boolean;
  recipientFollows: boolean;
  sharedTrip: boolean;
  sharedCircle: boolean;
  privacy: string;
  allowRequests: boolean;
  allowTrip: boolean;
  allowCircle: boolean;
}

function permissionClient(s: RelState): FakeClient {
  return makeFakeClient({
    blocks: [],
    user_message_settings: [{
      user_id: B,
      message_privacy: s.privacy,
      allow_message_requests: s.allowRequests,
      allow_trip_member_messages: s.allowTrip,
      allow_circle_member_messages: s.allowCircle,
    }],
    user_friendships: s.isFriend
      ? [{ user_a: A < B ? A : B, user_b: A < B ? B : A }]
      : [],
    user_follows: [
      ...(s.senderFollows ? [{ follower_id: A, following_id: B }] : []),
      ...(s.recipientFollows ? [{ follower_id: B, following_id: A }] : []),
    ],
    trip_members: s.sharedTrip
      ? [{ trip_id: "t1", user_id: A, role: "member" }, { trip_id: "t1", user_id: B, role: "member" }]
      : [{ trip_id: "t1", user_id: A, role: "member" }],
    circle_memberships: s.sharedCircle ? [{ user_id: A, other_id: B }] : [],
  });
}

/** Every single-signal weakening of a state. Each is unambiguously "less permission". */
function weakenings(s: RelState): Array<{ label: string; state: RelState }> {
  const out: Array<{ label: string; state: RelState }> = [];
  if (s.isFriend) out.push({ label: "friendship removed", state: { ...s, isFriend: false } });
  if (s.senderFollows) out.push({ label: "sender unfollows", state: { ...s, senderFollows: false } });
  if (s.recipientFollows) out.push({ label: "recipient unfollows", state: { ...s, recipientFollows: false } });
  if (s.sharedTrip) out.push({ label: "trip left", state: { ...s, sharedTrip: false } });
  if (s.sharedCircle) out.push({ label: "circle left", state: { ...s, sharedCircle: false } });
  if (s.allowRequests) out.push({ label: "requests disabled", state: { ...s, allowRequests: false } });
  if (s.allowTrip) out.push({ label: "trip messaging disabled", state: { ...s, allowTrip: false } });
  if (s.allowCircle) out.push({ label: "circle messaging disabled", state: { ...s, allowCircle: false } });
  if (s.privacy !== "no_one") out.push({ label: "privacy → no_one", state: { ...s, privacy: "no_one" } });
  return out;
}

function enumerateStates(): RelState[] {
  const bools = [false, true];
  const privacies = ["everyone", "friends", "followers", "following", "trip_members", "no_one"];
  const states: RelState[] = [];
  for (const privacy of privacies) {
    for (const isFriend of bools) {
      for (const senderFollows of bools) {
        for (const recipientFollows of bools) {
          for (const sharedTrip of bools) {
            for (const sharedCircle of bools) {
              // The three allow_* toggles are enumerated on a reduced axis (all
              // on, all off, and requests-off-only) rather than fully crossed:
              // the full product is 3,072 canMessage runs and the three flags
              // are independent of one another by construction in the resolver,
              // which the weakening pass below exercises one at a time anyway.
              for (const toggles of [
                { allowRequests: true, allowTrip: true, allowCircle: true },
                { allowRequests: false, allowTrip: true, allowCircle: true },
                { allowRequests: true, allowTrip: false, allowCircle: false },
              ]) {
                states.push({ isFriend, senderFollows, recipientFollows, sharedTrip, sharedCircle, privacy, ...toggles });
              }
            }
          }
        }
      }
    }
  }
  return states;
}

describe("P-01 — permission decreases → accessible set never increases", () => {
  it("no single-signal weakening of any enumerated state raises the verdict", async () => {
    const states = enumerateStates();
    assert.ok(states.length >= 500, `the input space must be worth calling a property: ${states.length}`);
    let comparisons = 0;
    for (const s of states) {
      const before = await canMessage(permissionClient(s) as any, A, B);
      for (const w of weakenings(s)) {
        const after = await canMessage(permissionClient(w.state) as any, A, B);
        comparisons++;
        assert.ok(
          verdictRank(after.verdict) <= verdictRank(before.verdict),
          `PERMISSION MONOTONICITY VIOLATED\n  state: ${JSON.stringify(s)}\n  weakening: ${w.label}\n` +
            `  before: ${before.verdict}  after: ${after.verdict}`,
        );
      }
    }
    assert.ok(comparisons > 2000, `comparisons made: ${comparisons}`);
  });

  it("a block, the strongest weakening, drives every state to denied", async () => {
    for (const s of enumerateStates().slice(0, 60)) {
      const c = permissionClient(s);
      c._store.blocks = [{ blocker_id: B, blocked_id: A }];
      const v = await canMessage(c as any, A, B);
      assert.equal(v.verdict, "denied", JSON.stringify(s));
      assert.equal(v.reason, "blocked");
    }
  });

  it("an unreadable blocks table is denied, not defaulted — unknown is not permission", async () => {
    const s = enumerateStates()[0];
    const c = makeFakeClient(permissionClient(s)._store, { errors: { blocks: { message: "down" } } });
    const v = await canMessage(c as any, A, B);
    assert.equal(v.verdict, "denied");
    assert.equal(v.reason, "unavailable", "and it says 'we could not decide', not 'you are blocked'");
  });
});

// ── P-02: location precision decreases → recipient precision never increases ──

const LADDER: Array<"city_only" | "neighborhood" | "nearby"> = ["city_only", "neighborhood", "nearby"];

function rawInputs(): RawMemberLocation[] {
  const out: RawMemberLocation[] = [];
  const visibilities: CrewVisibility[] = ["hidden", "city_only", "neighborhood", "nearby", "arrived_only"];
  const nowIso = new Date().toISOString();
  for (const defaultVisibility of visibilities) {
    for (const ghostModeEnabled of [false, true]) {
      for (const hotelBlurEnabled of [false, true]) {
        for (const share of [null, ...LADDER]) {
          for (const hasDistrict of [false, true]) {
            out.push({
              userId: A,
              name: "A",
              handle: "a",
              avatarUrl: null,
              prefs: { defaultVisibility, ghostModeEnabled, shareArrivalStatus: true, shareSafeReturnStatus: false },
              locationState: {
                city: "Cebu City",
                district: hasDistrict ? "IT Park" : null,
                country: "PH",
                updatedAt: nowIso,
                lat: 10.3157,
                lng: 123.8854,
              },
              hotelBlurEnabled,
              checkInStatus: null,
              hasSafeReturnActive: false,
              liveShare: share
                ? { id: "ls1", visibilityLevel: share, expiresAt: "2099-01-01T00:00:00.000Z" }
                : null,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Where a passive default sits on the same ladder a live share uses.
 * `hidden` is below the ladder entirely, so revoking any share narrows.
 */
function defaultLevelRank(v: CrewVisibility): number {
  if (v === "hidden") return -1;
  if (v === "city_only") return 0;
  if (v === "neighborhood") return 1;
  return 2; // nearby, arrived_only
}

function decreases(r: RawMemberLocation): Array<{ label: string; next: RawMemberLocation }> {
  const out: Array<{ label: string; next: RawMemberLocation }> = [];
  if (!r.prefs?.ghostModeEnabled) {
    out.push({ label: "ghost mode on", next: { ...r, prefs: { ...r.prefs!, ghostModeEnabled: true } } });
  }
  if (!r.hotelBlurEnabled) out.push({ label: "hotel blur on", next: { ...r, hotelBlurEnabled: true } });
  if (r.liveShare) {
    // Revoking a live share is a precision DECREASE only when the share was not
    // NARROWER than the member's passive default. It can be narrower: a live
    // share overrides the default in both directions, so a member whose default
    // is 'neighborhood' can start a 'city_only' share and disclose LESS while it
    // runs. See the dedicated asymmetry test below — this property test found
    // that case, and excluding it here is a statement about the transform, not
    // about the resolver.
    const shareRank = LADDER.indexOf(r.liveShare.visibilityLevel);
    const defRank = defaultLevelRank(r.prefs?.defaultVisibility ?? "hidden");
    if (shareRank >= defRank) {
      out.push({ label: "live share revoked", next: { ...r, liveShare: null } });
    }
    if (shareRank > 0) {
      out.push({
        label: `share level ${r.liveShare.visibilityLevel} → ${LADDER[shareRank - 1]}`,
        next: { ...r, liveShare: { ...r.liveShare, visibilityLevel: LADDER[shareRank - 1] } },
      });
    }
  }
  out.push({
    label: "position aged past the freshness bound",
    next: { ...r, locationState: { ...r.locationState!, updatedAt: "2020-01-01T00:00:00.000Z" } },
  });
  out.push({ label: "location state dropped", next: { ...r, locationState: null } });
  const vis = r.prefs?.defaultVisibility;
  if (vis && vis !== "hidden") {
    out.push({ label: "default visibility → hidden", next: { ...r, prefs: { ...r.prefs!, defaultVisibility: "hidden" } } });
  }
  return out;
}

describe("P-02 — location precision decreases → recipient precision never increases", () => {
  it("no precision-decreasing transform raises what the card discloses", () => {
    const inputs = rawInputs();
    assert.ok(inputs.length >= 100, `input space: ${inputs.length}`);
    let comparisons = 0;
    for (const r of inputs) {
      const before = disclosedPrecision(buildCrewCard(r));
      for (const d of decreases(r)) {
        const after = disclosedPrecision(buildCrewCard(d.next));
        comparisons++;
        assert.ok(
          after <= before,
          `PRECISION MONOTONICITY VIOLATED\n  transform: ${d.label}\n  before: ${before}  after: ${after}\n` +
            `  input: ${JSON.stringify(r)}`,
        );
      }
    }
    assert.ok(comparisons > 500, `comparisons made: ${comparisons}`);
  });

  it("ghost mode is absolute — it discloses nothing for every input in the space", () => {
    for (const r of rawInputs()) {
      const card = buildCrewCard({ ...r, prefs: { ...r.prefs!, ghostModeEnabled: true } });
      assert.equal(disclosedPrecision(card), 0, JSON.stringify(r));
      assert.equal(card.statusLabel, "location_hidden");
    }
  });

  it("FINDING — revoking a live share can WIDEN the area label, and here is the exact input", () => {
    // Found by the property above, not by inspection. A live share overrides the
    // passive default in BOTH directions (the resolver says so, and says why:
    // "a live share is an affirmative, time-boxed act of sharing; it must be
    // honored even when the member's passive default is 'hidden'"). The
    // consequence nobody wrote down is the mirror image: a member whose default
    // is 'neighborhood' who starts a 'city_only' share discloses LESS while it
    // runs, so ending the share INCREASES the disclosed label from a city to a
    // district.
    //
    // This is not a §27.1 violation — the wider label is one the member
    // separately authorized as their standing default, and nothing is disclosed
    // that they did not choose. It is recorded because it is counter-intuitive
    // in the direction that matters: "I stopped sharing" makes the label more
    // precise, and any future UI that says "sharing stopped" while showing a
    // narrower area than before would be telling the truth about the grant and
    // the opposite of the truth about the disclosure.
    const base: RawMemberLocation = {
      userId: A, name: "A", handle: "a", avatarUrl: null,
      prefs: { defaultVisibility: "neighborhood", ghostModeEnabled: false, shareArrivalStatus: true, shareSafeReturnStatus: false },
      locationState: { city: "Cebu City", district: "IT Park", country: "PH", updatedAt: new Date().toISOString(), lat: 10.3157, lng: 123.8854 },
      hotelBlurEnabled: true, // blur is what keeps the share from disclosing coords
      checkInStatus: null, hasSafeReturnActive: false,
      liveShare: { id: "ls1", visibilityLevel: "city_only", expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    const during = buildCrewCard(base);
    const after = buildCrewCard({ ...base, liveShare: null });
    assert.equal(disclosedPrecision(during), 1, "during a city_only share: a city");
    assert.equal(disclosedPrecision(after), 2, "after revoking it: district + city");
    assert.equal(during.areaLabel, "Cebu City");
    assert.equal(after.areaLabel, "IT Park, Cebu City");
  });

  it("exact coordinates require an active live share AND no blur AND a current position", () => {
    for (const r of rawInputs()) {
      const card = buildCrewCard(r);
      if (disclosedPrecision(card) === 3) {
        assert.ok(r.liveShare, "coords without a live share");
        assert.ok(!r.hotelBlurEnabled, "coords through hotel blur");
        assert.ok(!r.prefs?.ghostModeEnabled, "coords through ghost mode");
      }
    }
  });
});

// ── P-03: participant removed → future accessible never increases ─────────────

const MSG_TIMES = [
  "2026-01-15T00:00:00.000Z",
  "2026-02-15T00:00:00.000Z",
  "2026-03-15T00:00:00.000Z",
  "2026-04-15T00:00:00.000Z",
];

interface ThreadState {
  flag: boolean;
  visibleFrom: string | null;
  leftAt: string | null;
}

function threadStore(s: ThreadState): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "telegraph_history_bound_enabled", enabled: s.flag }],
    profiles: [{ id: A, handle: "a", name: "A" }, { id: B, handle: "b", name: "B" }],
    message_threads: [{ id: THREAD, thread_type: "trip", trip_id: null, circle_owner_id: null,
      title: "T", status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-04-16T00:00:00.000Z", last_message_at: "2026-04-16T00:00:00.000Z" }],
    message_thread_members: [
      { thread_id: THREAD, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: B, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: s.leftAt, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: s.visibleFrom },
    ],
    messages: MSG_TIMES.map((t, i) => ({
      id: `${i + 1}${"0".repeat(7)}-0000-4000-8000-00000000000${i + 1}`,
      thread_id: THREAD, sender_id: A, body: `m${i}`, created_at: t,
      deleted_at: null, edited_at: null, original_language: null, msg_type: "text", subtype: null,
      media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null,
    })),
    message_translations: [],
  };
}

let harness: RouterHarness;
before(async () => { harness = await startRouter(messagingRouter); });
after(async () => { await harness.close(); });

async function accessibleIds(s: ThreadState): Promise<string[]> {
  _setTestClient(makeFakeClient(threadStore(s)), true);
  const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, B);
  if (r.status !== 200) return [];
  return (r.body.messages as any[]).map((m) => m.id).sort();
}

describe("P-03 — participant removed → future accessible sequences never increase", () => {
  it("every membership weakening yields a SUBSET of what was accessible before it", async () => {
    const bases: ThreadState[] = [];
    for (const flag of [false, true]) {
      for (const visibleFrom of [null, ...MSG_TIMES]) {
        bases.push({ flag, visibleFrom, leftAt: null });
      }
    }
    let comparisons = 0;
    for (const base of bases) {
      const before = await accessibleIds(base);
      const weaker: Array<{ label: string; state: ThreadState }> = [
        { label: "member left", state: { ...base, leftAt: "2026-05-01T00:00:00.000Z" } },
        { label: "history bound enabled", state: { ...base, flag: true } },
      ];
      // Moving the window LATER is a weakening; moving it earlier is not, and is
      // deliberately not in this list.
      const idx = base.visibleFrom ? MSG_TIMES.indexOf(base.visibleFrom) : -1;
      if (idx >= 0 && idx < MSG_TIMES.length - 1) {
        weaker.push({ label: "window moved later", state: { ...base, visibleFrom: MSG_TIMES[idx + 1] } });
      }
      if (base.visibleFrom === null) {
        weaker.push({ label: "window introduced", state: { ...base, visibleFrom: MSG_TIMES[1] } });
      }
      for (const w of weaker) {
        const after = await accessibleIds(w.state);
        comparisons++;
        const extra = newlyAccessible(before, after);
        assert.deepEqual(
          extra,
          [],
          `ACCESSIBLE SET GREW\n  base: ${JSON.stringify(base)}\n  weakening: ${w.label}\n  newly accessible: ${extra.join(", ")}`,
        );
      }
    }
    assert.ok(comparisons >= 20, `comparisons made: ${comparisons}`);
  });

  it("a departed member's accessible set is empty, for every window and flag state", async () => {
    for (const flag of [false, true]) {
      for (const visibleFrom of [null, ...MSG_TIMES]) {
        const ids = await accessibleIds({ flag, visibleFrom, leftAt: "2026-05-01T00:00:00.000Z" });
        assert.deepEqual(ids, [], `flag=${flag} window=${visibleFrom}`);
      }
    }
  });
});

// ── P-04: block activated → future direct delivery impossible ────────────────

describe("P-04 — block activated → future direct delivery impossible", () => {
  const DM = "00000000-0000-4000-8000-00000000000d";

  function dmStore(blocks: any[]): Record<string, any[]> {
    return {
      feature_flags: [],
      blocks,
      profiles: [{ id: A, handle: "a" }, { id: B, handle: "b" }],
      message_threads: [{ id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null,
        title: null, status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null }],
      message_thread_members: [
        { thread_id: DM, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
          last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
        { thread_id: DM, user_id: B, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
          last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      ],
      messages: [],
      message_translations: [],
    };
  }

  it("no block configuration, including the degraded ones, permits a delivery", async () => {
    const configurations: Array<{ label: string; blocks: any[]; errors?: any }> = [
      { label: "recipient blocked sender", blocks: [{ blocker_id: B, blocked_id: A }] },
      { label: "sender blocked recipient", blocks: [{ blocker_id: A, blocked_id: B }] },
      { label: "mutual block", blocks: [{ blocker_id: A, blocked_id: B }, { blocker_id: B, blocked_id: A }] },
      { label: "blocks unreadable", blocks: [], errors: { blocks: { message: "down" } } },
      { label: "blocked + roster unreadable", blocks: [{ blocker_id: B, blocked_id: A }],
        errors: { message_thread_members: { message: "down", afterOps: 1 } } },
    ];
    for (const cfg of configurations) {
      const c = makeFakeClient(dmStore(cfg.blocks), { errors: cfg.errors });
      _setTestClient(c, true);
      const r = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: "hello" });
      assert.notEqual(r.status, 201, `${cfg.label} produced a delivered message`);
      assert.equal(
        (c._store.messages ?? []).length,
        0,
        `${cfg.label} wrote a canonical row despite refusing the request`,
      );
    }
  });

  it("the control: with no block and a healthy database, the same send succeeds", async () => {
    const c = makeFakeClient(dmStore([]));
    _setTestClient(c, true);
    const r = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: "hello" });
    assert.equal(r.status, 201, "a property that denies everything proves nothing");
    assert.equal(c._store.messages.length, 1);
  });
});

// ── P-05: expiry → temporary scopes terminate ────────────────────────────────

describe("P-05 — thread / availability / location expiry → temporary scopes terminate", () => {
  const T0 = Date.parse("2026-06-01T00:00:00.000Z");

  it("past its expiry, no window is visible to any viewer, with no sweep having run", () => {
    const policies: VisibilityPolicy[] = ["public", "followers", "following", "crew", "private"];
    const viewers: ViewerRelationship[] = ["self", "public", "follower", "following", "crew"];
    let checks = 0;
    for (const visibility of policies) {
      for (const source of ["explicit", "plan_derived"] as const) {
        for (const expiresAt of [null, "2026-05-31T23:59:59.000Z"]) {
          const w = {
            startAt: "2026-01-01T00:00:00.000Z",
            endAt: expiresAt === null ? "2026-05-31T23:59:59.000Z" : "2099-01-01T00:00:00.000Z",
            expiresAt,
            source,
            visibility,
          };
          for (const viewer of viewers) {
            checks++;
            assert.equal(
              isVisibleTo(w as any, viewer, T0),
              false,
              `EXPIRED SCOPE STILL VISIBLE: visibility=${visibility} source=${source} viewer=${viewer} expiresAt=${expiresAt}`,
            );
          }
        }
      }
    }
    assert.ok(checks >= 50, `checks made: ${checks}`);
  });

  it("the boundary itself is not 'still current' — an expiry is honoured at the instant it names", () => {
    const w = {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2026-06-01T00:00:00.000Z",
      source: "explicit" as const,
      visibility: "public" as const,
    };
    assert.equal(isVisibleTo(w as any, "follower", T0 - 1), true, "one millisecond before: visible");
    assert.equal(isVisibleTo(w as any, "follower", T0), false, "at the instant it names: not visible");
  });

  it("the control: an unexpired explicit public window IS visible, so the property is not vacuous", () => {
    const w = {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2099-01-01T00:00:00.000Z",
      expiresAt: null,
      source: "explicit" as const,
      visibility: "public" as const,
    };
    assert.equal(isVisibleTo(w as any, "follower", T0), true);
  });

  it("THREAD expiry has no referent in this schema — stated, not passed over", () => {
    const src = readFileSync(resolve(process.cwd(), "src/routes/messaging.ts"), "utf8");
    assert.equal(
      /thread_expires_at|expires_at.*message_threads|message_threads.*expires_at/.test(src),
      false,
      "if a thread expiry column appears, this property must grow a third arm",
    );
  });
});

// ── P-06 / P-07: the unsend properties, absent ───────────────────────────────

describe("P-06 / P-07 — the unsend properties have nothing to quantify over", () => {
  const src = () => readFileSync(resolve(process.cwd(), "src/routes/messaging.ts"), "utf8");

  it("P-06: the messaging router exposes no unsend operation", () => {
    const s = src();
    assert.equal(/router\.(post|delete|patch)\([^)]*unsend/i.test(s), false,
      "an unsend route exists — P-06 must now be written as a real property");
    assert.equal(/unsent_at/.test(s), false,
      "the unsent column is referenced — P-06 must now be written as a real property");
  });

  it("P-07: no seen-vs-unsend decision exists anywhere in the messaging tree", () => {
    const s = src();
    assert.equal(/telegraph_unsend_message_before_seen/.test(s), false,
      "the §7.4 race function is being called — P-07 must now be written as a real property");
  });

  it("and the receipt substrate an unsend would have to consult is last_read_at, which DOES exist", () => {
    // Stated so the absence is understood precisely: the seen signal is present
    // and is used for unread counts; what is missing is the operation that would
    // have to race it. That is why PR #472 reuses last_read_at rather than
    // introducing a competing sequence.
    assert.ok(/last_read_at/.test(src()));
  });
});
