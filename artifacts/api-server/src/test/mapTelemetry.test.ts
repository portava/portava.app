/**
 * mapTelemetry — the ingest route's privacy backstop (Map spec §35, §23, §24).
 *
 * The client scrubber is the first line of defence and it is thorough. These
 * tests cover the SECOND line, which exists precisely because the first one
 * runs on a device we do not control: an old build, a modified build, or a
 * replayed request can all present a payload the scrubber never saw.
 *
 * A telemetry store is the worst place for raw location to accumulate — it does
 * so silently, forever, and nobody notices until it is a breach. So the server
 * re-checks rather than trusts, and these tests pin that it actually does.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DISALLOWED_KEY_FRAGMENTS,
  MAP_EVENT_NAMES,
  containsDisallowedKey,
  stripActorKeys,
} from "../routes/mapTelemetry.js";

describe("the §35 event set", () => {
  test("carries §35s sixteen events, plus only deliberate additions", () => {
    // §35 names sixteen. `meet_here_refused` is a SEVENTEENTH, added
    // deliberately (migration 2222): §35 has no event for something the product
    // refused to do, so a §23 policy block was indistinguishable from a feature
    // nobody used. Keeping the spec list separate means it stays a faithful
    // quote and any further addition is a deliberate edit here.
    const SPEC_35 = [
      "alternative_requested",
      "compass_option_selected",
      "compass_requested",
      "contribution_submitted",
      "crew_locate_started",
      "live_state_viewed",
      "map_opened",
      "meet_here_created",
      "place_opened",
      "plan_joined",
      "recommendation_accepted",
      "recommendation_declined",
      "route_started",
      "trip_stop_added",
      "why_shown_opened",
      "zone_selected",
    ];
    const BEYOND_SPEC = ["meet_here_refused"];

    for (const name of SPEC_35) {
      assert.ok(
        (MAP_EVENT_NAMES as readonly string[]).includes(name),
        `§35 event missing from the server allowlist: ${name}`,
      );
    }
    assert.deepEqual(
      [...MAP_EVENT_NAMES].sort(),
      [...SPEC_35, ...BEYOND_SPEC].sort(),
      "the server event allowlist drifted — an event the client can emit but the server drops is a silent data loss",
    );
    assert.equal(MAP_EVENT_NAMES.length, SPEC_35.length + BEYOND_SPEC.length);
  });

  test("has no duplicates", () => {
    assert.equal(new Set(MAP_EVENT_NAMES).size, MAP_EVENT_NAMES.length);
  });
});

describe("containsDisallowedKey — position", () => {
  test("catches a raw coordinate pair at the top level", () => {
    assert.equal(containsDisallowedKey({ lat: 16.05, lng: 108.2 }), true);
    assert.equal(containsDisallowedKey({ latitude: 1, longitude: 2 }), true);
  });

  test("catches a coordinate NESTED inside an innocent-looking object", () => {
    assert.equal(
      containsDisallowedKey({ ref: { kind: "place", coordinates: [1, 2] } }),
      true,
    );
    assert.equal(
      containsDisallowedKey({ a: { b: { c: { lat: 1 } } } }),
      true,
    );
  });

  test("catches a coordinate hidden inside an ARRAY element", () => {
    // The obvious bypass: bury it one array deep and hope the walk only
    // recurses through objects.
    assert.equal(containsDisallowedKey({ options: [{ ok: 1 }, { lng: 2 }] }), true);
    assert.equal(containsDisallowedKey({ deep: [[{ geometry: {} }]] }), true);
  });

  test("catches geometry, geohash, bbox and street-level address keys", () => {
    for (const key of ["geometry", "geohash", "bbox", "street", "postcode", "address", "accuracy", "altitude"]) {
      assert.equal(containsDisallowedKey({ [key]: "x" }), true, `${key} must be rejected`);
    }
  });

  test("matching is case-insensitive", () => {
    assert.equal(containsDisallowedKey({ LAT: 1 }), true);
    assert.equal(containsDisallowedKey({ GeoHash: "x" }), true);
    assert.equal(containsDisallowedKey({ Display_Name: "x" }), true);
  });
});

describe("containsDisallowedKey — identity", () => {
  test("catches third-party identifiers", () => {
    for (const key of [
      "user_id", "contributor", "author", "owner", "profile_id", "creator",
      "host_id", "invitee_id", "actor", "account_id", "handle", "email",
      "phone", "avatar", "display_name", "username", "device_id", "push_token",
    ]) {
      assert.equal(containsDisallowedKey({ [key]: "x" }), true, `${key} must be rejected`);
    }
  });

  test("every declared fragment is actually enforced", () => {
    // Guards against a fragment being added to the list but the matcher
    // drifting so it no longer applies.
    for (const frag of DISALLOWED_KEY_FRAGMENTS) {
      assert.equal(
        containsDisallowedKey({ [`x_${frag}_y`]: 1 }),
        true,
        `declared fragment "${frag}" is not enforced`,
      );
    }
  });
});

describe("containsDisallowedKey — what it must NOT reject", () => {
  test("a well-formed scrubbed payload passes", () => {
    assert.equal(
      containsDisallowedKey({
        ref: {
          kind: "hidden_gem",
          privacyClass: "approximate",
          confidence: "live",
          freshness: "recent",
          cell: "w7s3x",
          cellPrecision: 5,
        },
        source: "carousel",
        rank: 3,
      }),
      false,
    );
  });

  test("primitives and empty objects pass", () => {
    assert.equal(containsDisallowedKey({}), false);
    assert.equal(containsDisallowedKey(null), false);
    assert.equal(containsDisallowedKey("a string"), false);
    assert.equal(containsDisallowedKey(42), false);
    assert.equal(containsDisallowedKey([]), false);
  });
});

describe("containsDisallowedKey — fails closed", () => {
  test("a payload nested beyond the inspection depth is REFUSED, not accepted", () => {
    // If the walk cannot verify the whole structure, the safe answer is
    // "assume it is dirty". Accepting the unverifiable is how coordinates end
    // up in a store nobody audits.
    let deep: Record<string, unknown> = { safe: 1 };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    assert.equal(containsDisallowedKey(deep), true);
  });

  test("a shallow payload is not falsely refused by the depth guard", () => {
    assert.equal(containsDisallowedKey({ a: { b: { c: { d: 1 } } } }), false);
  });
});

describe("stripActorKeys — the actor is stamped, never accepted", () => {
  test("removes every spelling of a client-supplied actor", () => {
    const out = stripActorKeys({
      viewer_id: "spoofed",
      viewerId: "spoofed",
      user_id: "spoofed",
      userId: "spoofed",
      actor: "spoofed",
      source: "rail",
    });
    assert.deepEqual(out, { source: "rail" });
  });

  test("leaves an ordinary payload untouched", () => {
    const payload = { source: "rail", rank: 2, ref: { kind: "place" } };
    assert.deepEqual(stripActorKeys(payload), payload);
  });

  test("returns a NEW object — the caller's payload is not mutated", () => {
    const payload = { viewer_id: "x", keep: 1 };
    const out = stripActorKeys(payload);
    assert.notEqual(out, payload);
    assert.equal((payload as any).viewer_id, "x", "input must not be mutated");
  });

  test("an actor key that survived stripping would still be caught downstream", () => {
    // Belt and braces: stripActorKeys handles the top level, and the identity
    // fragments in containsDisallowedKey catch anything nested.
    assert.equal(containsDisallowedKey({ ref: { user_id: "x" } }), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M259–M274 / M275 — the ingest route, driven end to end (census-map §35)
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above this line tests two exported helpers in isolation. Nothing
// above it drives the ROUTE, and the route is where the requirement lives:
// §35's sixteen rows each say "this event has a real emitter and it cannot
// land". Sixteen green helper tests are compatible with a route that writes
// the wrong column, writes nothing, or writes while the flag is off.
//
// So these cases post real batches at a real Express mount of the real router
// and assert what reached `map_telemetry_events`:
//
//   * flag TRUE  — the event produces EXACTLY ONE row, its `event_name` equals
//     the §35 name, and its `map_session_id` is the session `map_opened`
//     minted (not a second session, not null, not the event's own name).
//   * flag FALSE — ZERO event rows, AND the discard is recorded in
//     `map_telemetry_drops`. The second half is the point: commit 63772b76c
//     found that "every production map telemetry event was silently
//     discarded", and a flag that discards in silence is exactly how that
//     stayed unnoticed. A discard that writes a counter row is a discard
//     somebody can see.
//
// ── ON THE FAKE CLIENT, AND WHAT IT CANNOT BE ASKED ────────────────────────
// The double below is a recorder; like every fake in this repo it answers
// "does my fixture's value appear in what you passed", never "is that a real
// label of that column". It is therefore structurally incapable of returning
// 23514, so it CANNOT establish that `map_telemetry_events` would accept the
// names the route writes. Two things close that gap instead:
//
//   1. `the event allowlist matches the database CHECK` below reads the label
//      set out of the MIGRATION that defines the constraint, so drift between
//      the route's allowlist and the column's vocabulary fails here; and
//   2. the same rows were inserted into the live `portava-ci`
//      `map_telemetry_events` and read back (16 rows, 16 distinct events, one
//      session, max one row per event), and near-miss labels and a raw
//      coordinate payload were both refused there by the real constraints.
//      That run is recorded in the lane report, not re-executed here — this
//      suite must stay runnable without a database.
import http from "node:http";
import { before, after, beforeEach } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient, _setTestServiceClient } from "../lib/http.js";
import mapTelemetryRouter from "../routes/mapTelemetry.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dir, "..", "migrations");

const TOKEN = "map-telemetry-route-test-token";
const USER = "5f1e0c00-0000-4000-8000-00000000000c";

/** The session id `map_opened` mints. Every later event must carry THIS one. */
const SESSION = "mse_route_test_session";
/** A second session that appears in no batch — the "any string passes" trap. */
const OTHER_SESSION = "mse_not_the_minted_one";

/** Every insert the route issued, in order: the whole observable effect. */
let inserts: Array<{ table: string; rows: any[] }> = [];
let flagEnabled = false;

function rowsInto(table: string): any[] {
  return inserts.filter((w) => w.table === table).flatMap((w) => w.rows);
}

function builder(table: string) {
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      if (table === "feature_flags" && col === "flag") q._flag = val;
      return q;
    },
    maybeSingle: async () => {
      if (table === "feature_flags") {
        // Only the telemetry flag is known to this fixture; anything else
        // answers "no such row", which `isFlagEnabled` reads as false.
        return q._flag === "map_telemetry_enabled"
          ? { data: { enabled: flagEnabled }, error: null }
          : { data: null, error: null };
      }
      // profiles — no row means "no ban state recorded", i.e. an active account.
      return { data: null, error: null };
    },
    insert: (data: any) => {
      inserts.push({ table, rows: Array.isArray(data) ? data : [data] });
      return q;
    },
    then: (res: (v: any) => void, rej?: (e: any) => void) =>
      Promise.resolve({ data: null, error: null }).then(res, rej),
  };
  return q;
}

const fakeClient = {
  auth: {
    getUser: async (token: string) =>
      token === TOKEN
        ? { data: { user: { id: USER } }, error: null }
        : { data: { user: null }, error: { message: "Unauthorized" } },
  },
  from: (table: string) => builder(table),
};

let server: http.Server;
let base = "";

function post(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/map/telemetry", base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

/** One §35 event, shaped exactly as the client emitter sends it. */
function event(name: string, seq: number, payload: Record<string, unknown> = {}) {
  return { name, mapSessionId: SESSION, seq, ts: 1_758_000_000_000 + seq, payload };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    next();
  });
  app.use(mapTelemetryRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  inserts = [];
  flagEnabled = false;
  _setTestClient(fakeClient as any, true);
  _setTestServiceClient(fakeClient as any);
});

// ── the allowlist against the column's real vocabulary ──────────────────────

/** The label set of the LAST migration to define map_telemetry_events_name_check. */
function checkLabelsFromMigrations(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let labels: string[] | null = null;
  let source = "";
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    const m = sql.match(
      /ADD\s+CONSTRAINT\s+map_telemetry_events_name_check\s+CHECK\s*\(\s*event_name\s+IN\s*\(([\s\S]*?)\)\s*\)/i,
    );
    if (!m) continue;
    labels = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    source = f;
  }
  assert.ok(labels, "no migration defines map_telemetry_events_name_check");
  assert.ok(labels!.length > 0, `${source} yielded no labels — the parse is broken`);
  return labels!;
}

describe("the event allowlist matches the database CHECK", () => {
  test("every name the route will write is a label the column accepts", () => {
    // The fake client cannot raise 23514. This can: a name the route accepts
    // but the CHECK does not is a row the database refuses AT RUNTIME, and the
    // route answers 200 either way, so the loss would be silent.
    const labels = new Set(checkLabelsFromMigrations());
    const notAccepted = MAP_EVENT_NAMES.filter((n) => !labels.has(n));
    assert.deepEqual(notAccepted, [], "the route would write a label the CHECK refuses");
  });

  test("every label the column accepts has a name the route will write", () => {
    const declared = new Set<string>(MAP_EVENT_NAMES);
    const unreachable = checkLabelsFromMigrations().filter((l) => !declared.has(l));
    assert.deepEqual(unreachable, [], "a stored vocabulary no emitter can reach");
  });

  test("the parse actually found the constraint (anti-vacuity)", () => {
    // Two empty sets agree. If the regex stops matching, the two cases above
    // pass while checking nothing, so the count is pinned independently.
    assert.equal(
      checkLabelsFromMigrations().length,
      MAP_EVENT_NAMES.length,
      "the migration-derived label count and the route allowlist must agree",
    );
  });
});

// ── M259–M274: one row per event, on map_opened's session ───────────────────

/**
 * §35's sixteen, in census order (M259 → M274), each with the row id that
 * owns it so a failure names the requirement rather than a string.
 */
const SPEC_35_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["M259", "map_opened"],
  ["M260", "zone_selected"],
  ["M261", "place_opened"],
  ["M262", "live_state_viewed"],
  ["M263", "why_shown_opened"],
  ["M264", "compass_requested"],
  ["M265", "compass_option_selected"],
  ["M266", "route_started"],
  ["M267", "trip_stop_added"],
  ["M268", "plan_joined"],
  ["M269", "meet_here_created"],
  ["M270", "crew_locate_started"],
  ["M271", "contribution_submitted"],
  ["M272", "alternative_requested"],
  ["M273", "recommendation_accepted"],
  ["M274", "recommendation_declined"],
];

describe("with map_telemetry_enabled TRUE, each §35 event lands exactly once", () => {
  for (const [row, name] of SPEC_35_ROWS) {
    test(`${row} ${name}: one row, right name, map_opened's session`, async () => {
      flagEnabled = true;
      // `map_opened` mints the session; the batch carries it and the event.
      const events =
        name === "map_opened"
          ? [event("map_opened", 1)]
          : [event("map_opened", 1), event(name, 2)];
      const res = await post({ events, meta: { schemaVersion: "1.0", mapSessionId: SESSION } });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.accepted, events.length, "every event in the batch must be accepted");
      assert.equal(res.body.rejected, 0);

      const written = rowsInto("map_telemetry_events");
      const mine = written.filter((r) => r.event_name === name);
      assert.equal(mine.length, 1, `${name} must produce exactly one row, got ${mine.length}`);
      assert.equal(mine[0].event_name, name, "the event column must equal the §35 name");
      assert.equal(
        mine[0].map_session_id,
        SESSION,
        "the row must carry the session map_opened minted",
      );
      assert.equal(
        mine[0].synthesized_session,
        false,
        "a session minted by map_opened is not synthetic",
      );
      assert.equal(mine[0].viewer_id, USER, "the actor is stamped from the token");
    });
  }

  test("anti-vacuity: a row whose session is NOT map_opened's is visible as such", async () => {
    // Every assertion above would also pass if `map_session_id` were ignored
    // and some constant written. It is not: a batch carrying a different
    // session id produces rows carrying THAT id, so the equality above is
    // doing work.
    flagEnabled = true;
    await post({
      events: [{ name: "zone_selected", mapSessionId: OTHER_SESSION, seq: 1, ts: 1, payload: {} }],
      meta: { schemaVersion: "1.0", mapSessionId: OTHER_SESSION },
    });
    const written = rowsInto("map_telemetry_events");
    assert.equal(written.length, 1);
    assert.equal(written[0].map_session_id, OTHER_SESSION);
    assert.notEqual(written[0].map_session_id, SESSION);
  });

  test("anti-vacuity: an event name outside §35 produces no row at all", async () => {
    flagEnabled = true;
    const res = await post({
      events: [event("map_opened", 1), event("map_open", 2)],
      meta: { schemaVersion: "1.0", mapSessionId: SESSION },
    });
    assert.equal(res.body.unknownName, 1);
    assert.equal(rowsInto("map_telemetry_events").length, 1, "only map_opened is stored");
  });
});

// ── the flag-off arm: zero rows, and a DROP that somebody can see ───────────

describe("with map_telemetry_enabled FALSE", () => {
  test("no event row is written", async () => {
    flagEnabled = false;
    const res = await post({
      events: SPEC_35_ROWS.map(([, n], i) => event(n, i + 1)),
      meta: { schemaVersion: "1.0", mapSessionId: SESSION },
    });
    assert.equal(res.status, 200, "telemetry must never block the client");
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.accepted, 0);
    assert.equal(rowsInto("map_telemetry_events").length, 0);
  });

  test("the discard is RECORDED in map_telemetry_drops, not silent", async () => {
    // The whole finding of commit 63772b76c was a silent discard. A flag that
    // throws a batch away and writes nothing is indistinguishable, from the
    // data, from a map nobody opened.
    flagEnabled = false;
    await post({
      events: SPEC_35_ROWS.map(([, n], i) => event(n, i + 1)),
      meta: { schemaVersion: "1.0", mapSessionId: SESSION },
    });
    const drops = rowsInto("map_telemetry_drops");
    assert.equal(drops.length, 1, "a disabled flag must leave a drop counter behind");
    assert.equal(drops[0].dropped, SPEC_35_ROWS.length, "every discarded event is counted");
    assert.equal(drops[0].map_session_id, SESSION);
    assert.equal(drops[0].viewer_id, USER);
    assert.equal(
      (drops[0].dropped_by_reason as Record<string, number>).flag_disabled,
      SPEC_35_ROWS.length,
      "the reason must say the flag, not just that something was lost",
    );
  });

  test("anti-vacuity: an EMPTY batch with the flag off writes no drop row", async () => {
    // Otherwise "a drop row exists" is satisfied by writing one unconditionally.
    flagEnabled = false;
    await post({ events: [], meta: { schemaVersion: "1.0", mapSessionId: SESSION } });
    assert.equal(rowsInto("map_telemetry_drops").length, 0);
  });
});

// ── M275: one decisionId across the five outcome-loop events ────────────────

describe("M275 — one decisionId threads the outcome loop", () => {
  /** §35's outcome loop, in order. */
  const CHAIN = [
    "compass_requested",
    "compass_option_selected",
    "recommendation_accepted",
    "route_started",
    "contribution_submitted",
  ];

  test("all five rows reach the table carrying the same decisionId", async () => {
    flagEnabled = true;
    const decisionId = "dec_outcome_loop";
    await post({
      events: [
        event("map_opened", 1),
        ...CHAIN.map((n, i) => event(n, i + 2, { decisionId })),
      ],
      meta: { schemaVersion: "1.0", mapSessionId: SESSION },
    });

    // Asserted on the ROWS, as the census requires — not on what the client
    // put in the payload object it handed us.
    const written = rowsInto("map_telemetry_events");
    const chainRows = written.filter((r) => CHAIN.includes(r.event_name));
    assert.equal(chainRows.length, 5, "all five outcome events must be stored");
    const ids = new Set(chainRows.map((r) => (r.payload as any).decisionId));
    assert.deepEqual([...ids], [decisionId], "one id, not five");
    for (const r of chainRows) {
      assert.equal(r.map_session_id, SESSION, "the loop is within one map session");
    }
  });

  test("decisionId survives the privacy scrubbers rather than being stripped", () => {
    // `stripActorKeys` and `containsDisallowedKey` both run over this payload.
    // A fragment added to the denylist that happened to match "decisionid"
    // would delete the outcome loop entirely, and the route answers 200.
    assert.equal(containsDisallowedKey({ decisionId: "dec_x" }), false);
    assert.deepEqual(stripActorKeys({ decisionId: "dec_x" }), { decisionId: "dec_x" });
  });

  test("anti-vacuity: two different decisionIds are NOT collapsed into one", async () => {
    flagEnabled = true;
    await post({
      events: [
        event("map_opened", 1),
        event("compass_requested", 2, { decisionId: "dec_a" }),
        event("route_started", 3, { decisionId: "dec_b" }),
      ],
      meta: { schemaVersion: "1.0", mapSessionId: SESSION },
    });
    const ids = new Set(
      rowsInto("map_telemetry_events")
        .map((r) => (r.payload as any).decisionId)
        .filter(Boolean),
    );
    assert.equal(ids.size, 2, "the route must not rewrite or unify decision ids");
  });
});
