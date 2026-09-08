/**
 * canMessage — adversarial reads: what a FAILED read is allowed to say about a person.
 *
 * canMessage answers "may this person message that person". Every read it makes
 * is either an EXCLUSION signal (blocks, and the recipient's own privacy
 * setting), where an unchecked failure hands out permission that was never
 * granted, or an INCLUSION signal (friendship, follows, trips, circles), where
 * an unchecked failure withholds permission and then reports the absence as if
 * it were a fact about the pair.
 *
 * supabase-js RESOLVES on a database error. `const { data } = await ...` on a
 * failed read therefore yields exactly the shape of a clean empty result, so
 * neither category can be got right by accident.
 *
 * These tests also cover a third thing the resolver does with those two ids:
 * it interpolates them RAW into three PostgREST `.or()` filter strings.
 *
 * Run: node --import tsx/esm --test src/test/messagingPermissionsHardening.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { logger } from "../lib/logger.js";

/**
 * canMessage logs through `rootLogger.child({...})`, which pino evaluates ONCE
 * at module load and which returns an object with its OWN methods -- patching
 * `logger.error` afterwards captures nothing (a real trap: the assertions would
 * all read `undefined` and a careless test would assert around them and pass).
 * The child factory is therefore replaced BEFORE the module under test is
 * loaded, and the module is pulled in dynamically so that ordering holds.
 */
let captured: Array<{ level: string; obj: any; msg: string }> = [];
const capturingChild: any = {
  error: (obj: any, msg?: string) => captured.push({ level: "error", obj, msg: String(msg ?? obj) }),
  warn: (obj: any, msg?: string) => captured.push({ level: "warn", obj, msg: String(msg ?? obj) }),
  info: (obj: any, msg?: string) => captured.push({ level: "info", obj, msg: String(msg ?? obj) }),
  debug: () => {},
  child: () => capturingChild,
};
(logger as any).child = () => capturingChild;

const { canMessage } = await import("../lib/messagingPermissions.js");

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";

type Outcome = { data: any; error: any };

interface Recorded { table: string; or: string[]; ins: Array<[string, any[]]>; limit: number | null }

interface Opts {
  /** table -> forced error. */
  errors?: Record<string, { message: string }>;
  settings?: Record<string, any> | null;
  isFriend?: boolean;
  sharedCircle?: boolean;
  /** trip_members rows returned for the sender's own trips. */
  senderTrips?: any[];
  blockRow?: any;
}

let recorded: Recorded[] = [];

function makeClient(o: Opts) {
  const errors = o.errors ?? {};
  let followCall = 0;

  function builder(table: string, resolveTo: () => Outcome) {
    const rec: Recorded = { table, or: [], ins: [], limit: null };
    recorded.push(rec);
    const b: any = {
      select: () => b,
      eq: () => b,
      is: () => b,
      or: (s: string) => { rec.or.push(s); return b; },
      in: (c: string, v: any[]) => { rec.ins.push([c, v]); return b; },
      limit: (n: number) => { rec.limit = n; return b; },
      maybeSingle: async () => {
        const e = errors[table];
        return e ? { data: null, error: e } : resolveTo();
      },
      then: (res: any, rej: any) => {
        const e = errors[table];
        const v = e ? { data: null, error: e } : resolveTo();
        return Promise.resolve(v).then(res, rej);
      },
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "blocks") return builder(table, () => ({ data: o.blockRow ?? null, error: null }));
      if (table === "user_message_settings") return builder(table, () => ({ data: o.settings ?? null, error: null }));
      if (table === "user_friendships") return builder(table, () => ({ data: o.isFriend ? { user_a: A } : null, error: null }));
      if (table === "user_follows") { followCall++; return builder(table, () => ({ data: null, error: null })); }
      if (table === "circle_memberships") return builder(table, () => ({ data: o.sharedCircle ? { user_id: B } : null, error: null }));
      if (table === "trip_members") return builder(table, () => ({ data: o.senderTrips ?? [], error: null }));
      return builder(table, () => ({ data: null, error: null }));
    },
  } as any;
}

const errorsMatching = (re: RegExp) => captured.filter((c) => c.level === "error" && re.test(c.msg));

beforeEach(() => { recorded = []; captured = []; });

describe("canMessage — exclusion reads must fail CLOSED", () => {
  it("positive control: a clean 'everyone' recipient is allowed and NOT degraded", async () => {
    const r = await canMessage(makeClient({ settings: { message_privacy: "everyone" } }), A, B);
    assert.equal(r.verdict, "allowed");
    assert.equal(r.degraded, undefined, "a clean resolution must not claim degradation");
    assert.ok(recorded.length >= 5, `expected the resolver to issue its reads, saw ${recorded.length}`);
  });

  it("an unreadable blocks table denies with 'unavailable', never 'no block'", async () => {
    const r = await canMessage(
      makeClient({ errors: { blocks: { message: "57014 timeout" } }, settings: { message_privacy: "everyone" } }),
      A, B,
    );
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "unavailable",
      "'blocked' would be a fabrication and 'allowed' would deliver a message to someone who may have blocked the sender");
    assert.equal(errorsMatching(/blocks read failed/i).length, 1);
  });

  it("an unreadable user_message_settings denies instead of defaulting to 'everyone'", async () => {
    const r = await canMessage(makeClient({ errors: { user_message_settings: { message: "down" } } }), A, B);
    assert.equal(r.reason, "unavailable",
      "DEFAULT_SETTINGS.message_privacy is 'everyone' — defaulting here makes a restricted recipient messageable by anyone, precisely while the database is unhealthy");
  });
});

describe("canMessage — inclusion reads withhold permission, and say so", () => {
  it("a failed friendship read is logged and marks the verdict degraded", async () => {
    const r = await canMessage(
      makeClient({ errors: { user_friendships: { message: "deadlock" } }, settings: { message_privacy: "friends" } }),
      A, B,
    );
    // Withholding is the safe direction: this is not a permission bug.
    assert.equal(r.verdict, "requires_request");
    assert.equal(r.relationship_context.isFriend, false);
    // But `isFriend: false` is NOT a fact here, and the caller has to be able to tell.
    assert.equal(r.degraded, true, "a verdict resting on a failed read must not present itself as certain");
    const lines = errorsMatching(/relationship read failed/i);
    assert.equal(lines.length, 1, `expected one relationship-read error, saw ${JSON.stringify(captured.map((c) => c.msg))}`);
    assert.equal(lines[0]!.obj?.read, "user_friendships", "the log must name WHICH relationship could not be read");
  });

  it("a failed circle read marks degraded and is named", async () => {
    const r = await canMessage(
      makeClient({ errors: { circle_memberships: { message: "down" } }, settings: { message_privacy: "friends" } }),
      A, B,
    );
    assert.equal(r.degraded, true);
    assert.equal(errorsMatching(/relationship read failed/i)[0]!.obj?.read, "circle_memberships");
  });

  it("a failed trip read marks degraded without claiming 'not trip mates' as fact", async () => {
    const r = await canMessage(
      makeClient({ errors: { trip_members: { message: "down" } }, settings: { message_privacy: "trip_members" } }),
      A, B,
    );
    assert.equal(r.relationship_context.sharedTrip, false);
    assert.equal(r.degraded, true);
    assert.equal(errorsMatching(/shared-trip check degraded/i).length, 1);
  });

  it("an allowed verdict is also marked when a relationship read failed", async () => {
    // privacy=everyone allows regardless, but the context handed back is still partial.
    const r = await canMessage(
      makeClient({ errors: { user_follows: { message: "down" } }, settings: { message_privacy: "everyone" } }),
      A, B,
    );
    assert.equal(r.verdict, "allowed");
    assert.equal(r.degraded, true, "degradation is a property of the context, not of the verdict");
    assert.equal(errorsMatching(/relationship read failed/i).length, 2, "both follow directions must be reported");
  });

  it("healthy relationship reads leave the verdict unmarked and quiet", async () => {
    const r = await canMessage(makeClient({ settings: { message_privacy: "friends" }, isFriend: true }), A, B);
    assert.equal(r.verdict, "allowed");
    assert.equal(r.degraded, undefined);
    assert.deepEqual(errorsMatching(/./).map((c) => c.msg), []);
  });
});

describe("canMessage — the trip scan is bounded", () => {
  it("the sender's trip list carries an explicit limit", async () => {
    await canMessage(makeClient({ settings: { message_privacy: "everyone" } }), A, B);
    const tripScans = recorded.filter((r) => r.table === "trip_members");
    assert.ok(tripScans.length >= 1, "fixture check: the trip scan must have been issued");
    assert.ok(
      tripScans[0]!.limit !== null && tripScans[0]!.limit! > 0,
      "the trip list feeds .in(trip_id, ids); unbounded, PostgREST truncates it at db-max-rows and a genuinely shared trip is silently missed",
    );
  });

  it("a trip list at the cap is reported as degraded rather than accepted as complete", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ trip_id: `t${i}`, user_id: A, role: "member" }));
    const r = await canMessage(makeClient({ settings: { message_privacy: "everyone" }, senderTrips: many }), A, B);
    assert.equal(r.degraded, true, "a truncated trip list makes 'no shared trip' an unproven claim");
  });
});

describe("canMessage — participant ids are never pasted into a filter unchecked", () => {
  const INJECTIONS = [
    // Closes the and(...) group early and appends a clause that always matches,
    // which would make the block lookup stop selecting the real block row.
    "aaaaaaaa-0000-0000-0000-00000000000a),blocker_id.eq.00000000-0000-0000-0000-000000000000,and(x.eq.1",
    "*",
    "",
    "not-a-uuid",
  ];

  for (const bad of INJECTIONS) {
    it(`refuses a non-UUID sender id (${JSON.stringify(bad.slice(0, 32))})`, async () => {
      const r = await canMessage(makeClient({ settings: { message_privacy: "everyone" } }), bad, B);
      assert.equal(r.allowed, false, "a value that cannot name an account must not be resolved as one");
      assert.equal(r.reason, "unavailable");
      assert.equal(recorded.length, 0,
        "the refusal must come BEFORE any query is built — a filter assembled from this string is the vulnerability");
      assert.equal(errorsMatching(/non-UUID participant id/i).length, 1);
    });

    it(`refuses a non-UUID recipient id (${JSON.stringify(bad.slice(0, 32))})`, async () => {
      const r = await canMessage(makeClient({ settings: { message_privacy: "everyone" } }), A, bad);
      assert.equal(r.allowed, false);
      assert.equal(recorded.length, 0);
    });
  }

  it("a valid pair still reaches the blocks filter with both ids intact (positive control)", async () => {
    await canMessage(makeClient({ settings: { message_privacy: "everyone" } }), A, B);
    const blocks = recorded.find((r) => r.table === "blocks");
    assert.ok(blocks, "fixture check: the blocks read must have been issued");
    assert.equal(blocks!.or.length, 1);
    assert.ok(blocks!.or[0]!.includes(A) && blocks!.or[0]!.includes(B),
      "the guard must not have broken the real query it protects");
  });
});
