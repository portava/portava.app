/**
 * GET /trips/:tripId/presence — §10 becoming readable at all.
 *
 * THE GAP THIS CLOSES
 * ===================
 * Presence was built across five migrations — 2763 the table, 2767 the spec's
 * eight states and the `source` vocabulary, 2768 the SET/CLEAR commands, 2776
 * the freshness computation and the `trip_presence_current` view, 2777 the
 * out-of-order guard — and measured on 2026-09-09, NOTHING read any of it. No
 * route in the server named trip_presence; no file in the app did either. A
 * presence row nobody can read is not presence, and every one of those
 * migrations' careful distinctions was invisible.
 *
 * So what this file pins is the distinctions SURVIVING the trip to a client:
 *
 *   an expired row is RETURNED and labelled, not filtered — §10.4 needs
 *     "where they were an hour ago" to remain available and clearly not live
 *   `isCurrent` is decided once, here, from §10.2's rule, not in each client
 *   a crew member never observed is `noPresence`, NOT the `unknown` state,
 *     which is a thing a traveller actually reported
 *   `private` is honoured for everyone but its own subject
 *   a read that fails is 503, never an empty presence list
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { readFileSync } from "node:fs";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { presenceVisibleTo, CURRENT_FRESHNESS, PRESENCE_FRESHNESS } from "../routes/tripPresence.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const MATE_ID  = "22222222-2222-2222-2222-222222222222";
const GHOST_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const TRIP_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type Row = Record<string, any>;

function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const failing = (table: string): any => {
    const f: any = {
      select: () => f, eq: () => f, in: () => f, order: () => f,
      maybeSingle: async () => ({ data: null, error: { message: `${table} unavailable` } }),
      then: (onF: any, onR: any) =>
        Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(onF, onR),
    };
    return f;
  };
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "mate-token")  return { data: { user: { id: MATE_ID } },  error: null };
        if (token === "other-token") return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      if (errorOn.includes(table)) return failing(table);
      const filters: Array<(r: Row) => boolean> = [];
      let single = false;
      const settle = () => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        order: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        single: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
}

function presence(over: Row): Row {
  return {
    trip_id: TRIP_ID, user_id: OWNER_ID, presence_state: "here", visibility: "crew",
    source: "self_reported", confidence: 0.9,
    observed_at: "2026-10-01T12:00:00.000Z", expires_at: "2026-10-01T12:20:00.000Z",
    freshness: "live", expired: false, observed_seconds_ago: 60, ...over,
  };
}

const crew = [
  { trip_id: TRIP_ID, user_id: OWNER_ID, status: "accepted", role: "owner" },
  { trip_id: TRIP_ID, user_id: MATE_ID,  status: "accepted", role: "member" },
  { trip_id: TRIP_ID, user_id: GHOST_ID, status: "accepted", role: "member" },
];

let server: Server;
let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); });
  });
}
after(() => { server?.close(); });

async function get(token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/presence`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function install(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const c = makeClient(tables, errorOn);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
}

beforeEach(async () => { if (!server) await start(); });

describe("§10.2 — freshness reaches the client, and the decision is made once", () => {
  it("returns an EXPIRED row rather than filtering it, and says it is not current", async () => {
    // The forbidden shape: hiding an expired row makes "we know where they
    // were an hour ago" indistinguishable from "we have never known". §10.4
    // needs the first to remain available and clearly not live truth.
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      trip_presence_current: [
        presence({ user_id: MATE_ID, freshness: "offline", expired: true, observed_seconds_ago: 7200 }),
      ],
    });
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.body.presence.length, 1, "the expired row was filtered out");
    assert.equal(r.body.presence[0].expired, true);
    assert.equal(r.body.presence[0].freshness, "offline");
    assert.equal(r.body.presence[0].isCurrent, false);
    assert.equal(r.body.presence[0].observedSecondsAgo, 7200);
  });

  it("live and recent are current; last_known and offline are not", () => {
    // Pinned as a set rather than case by case, so a fifth label added to the
    // vocabulary cannot silently default to current.
    assert.deepEqual([...PRESENCE_FRESHNESS], ["live", "recent", "last_known", "offline"]);
    for (const f of PRESENCE_FRESHNESS) {
      assert.equal(CURRENT_FRESHNESS.has(f), f === "live" || f === "recent", `${f} classified wrongly`);
    }
  });

  it("carries provenance, and a null source is not read as self-reported", async () => {
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      trip_presence_current: [presence({ user_id: MATE_ID, source: null })],
    });
    const r = await get();
    assert.equal(r.body.presence[0].source, null,
      "a null source must stay null — it means 'we do not know how this was observed'");
  });

  it("stamps the SERVER's clock, so a client cannot compute staleness against a skewed one", async () => {
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      trip_presence_current: [presence({ user_id: MATE_ID })],
    });
    const r = await get();
    assert.ok(typeof r.body.asOf === "string" && !Number.isNaN(Date.parse(r.body.asOf)));
  });
});

describe("§10 — never observed is not the same as reporting 'unknown'", () => {
  it("a crew member with no row is in noPresence, not given an unknown state", async () => {
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      trip_presence_current: [
        presence({ user_id: OWNER_ID }),
        presence({ user_id: MATE_ID, presence_state: "unknown" }),
      ],
    });
    const r = await get();
    assert.deepEqual(r.body.noPresence, [GHOST_ID]);
    // And the member who genuinely reported 'unknown' is a presence row, not a
    // gap — the two states are what this test exists to keep apart.
    const mate = r.body.presence.find((p: any) => p.userId === MATE_ID);
    assert.equal(mate.state, "unknown");
    assert.ok(!r.body.noPresence.includes(MATE_ID));
  });

  it("an invited-but-not-accepted member is not counted as missing presence", async () => {
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: [...crew, { trip_id: TRIP_ID, user_id: OTHER_ID, status: "invited", role: "member" }],
      trip_presence_current: [presence({ user_id: OWNER_ID }), presence({ user_id: MATE_ID }), presence({ user_id: GHOST_ID })],
    });
    const r = await get();
    assert.deepEqual(r.body.noPresence, []);
  });
});

describe("§10.3 — visibility is a whitelist", () => {
  it("a private row is visible to its subject and to nobody else", async () => {
    const tables = {
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      trip_presence_current: [presence({ user_id: MATE_ID, visibility: "private" })],
    };
    install(tables);
    const asOwner = await get("owner-token");
    assert.equal(asOwner.body.presence.length, 0, "a private row leaked to another crew member");
    assert.ok(asOwner.body.noPresence.includes(MATE_ID),
      "a hidden row must leave its subject in noPresence, not silently absent from both lists");

    install(tables);
    const asSubject = await get("mate-token");
    assert.equal(asSubject.body.presence.length, 1);
    assert.equal(asSubject.body.presence[0].visibility, "private");
  });

  it("an UNRECOGNISED visibility is withheld, not shown", () => {
    // The safe direction to be wrong in when a vocabulary grows: withhold a
    // row, never publish a location.
    assert.equal(presenceVisibleTo({ user_id: MATE_ID, visibility: "public_someday" }, OWNER_ID), false);
    assert.equal(presenceVisibleTo({ user_id: MATE_ID, visibility: "crew" }, OWNER_ID), true);
    assert.equal(presenceVisibleTo({ user_id: MATE_ID, visibility: "participants" }, OWNER_ID), true);
    // Your own row, whatever it says.
    assert.equal(presenceVisibleTo({ user_id: OWNER_ID, visibility: "anything" }, OWNER_ID), true);
  });
});

describe("§10 — fail-closed", () => {
  it("an unreadable presence view is 503, never an empty presence list", async () => {
    // "Nobody on this trip has reported where they are" is a claim about the
    // crew. A query that did not answer has not established it.
    install({ trips: [{ id: TRIP_ID, owner_id: OWNER_ID }], trip_members: crew }, ["trip_presence_current"]);
    const r = await get();
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.presence, undefined);
  });

  it("an unreadable CREW list is 503 too — noPresence would otherwise say 'everyone reported'", async () => {
    install(
      { trips: [{ id: TRIP_ID, owner_id: OWNER_ID }], trip_presence_current: [presence({})] },
      ["trip_members"],
    );
    const r = await get();
    assert.equal(r.status, 503);
    assert.equal(r.body.presence, undefined);
  });

  it("a non-member is refused, not answered", async () => {
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      trip_presence_current: [presence({})],
    });
    const r = await get("other-token");
    assert.equal(r.status, 403);
    assert.equal(r.body.presence, undefined);
  });
});

describe("the CLIENT and the DATABASE agree on the vocabulary", () => {
  // WHY THIS IS A TEST AND NOT A COMMENT.
  //
  // The first draft of travel-buddy-standalone/src/services/tripPresence.ts
  // declared PRESENCE_STATES as at_home | travelling | in_transit | arrived |
  // at_location | nearby | away | unknown. Not one of those eight is a value
  // the database accepts. Every SET_PRESENCE the app sent would have come back
  // as a raw 23514 check violation, and nothing in either package's type
  // system could have noticed: one is TypeScript, the other is a CHECK
  // constraint in SQL.
  const client = readFileSync(
    new URL("../../../../travel-buddy-standalone/src/services/tripPresence.ts", import.meta.url),
    "utf8",
  );
  const m2767 = readFileSync(
    new URL("../migrations/2767_trip_presence_spec_vocabulary.sql", import.meta.url),
    "utf8",
  );
  const m2776 = readFileSync(
    new URL("../migrations/2776_trip_presence_freshness_and_ordering.sql", import.meta.url),
    "utf8",
  );

  /** The values inside a `export const NAME = [ ... ] as const;` block. */
  function clientList(name: string): string[] {
    const start = client.indexOf(`export const ${name} = [`);
    assert.ok(start > 0, `the client no longer declares ${name}`);
    const end = client.indexOf("] as const;", start);
    return [...client.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  }
  /** The values inside a named CHECK ... IN ( ... ) in a migration. */
  function checkVocabulary(sql: string, constraint: string): string[] {
    const at = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
    assert.ok(at > 0, `${constraint} is not added by that migration any more`);
    const open = sql.indexOf("IN (", at);
    const close = sql.indexOf(")", open);
    return [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  }

  it("PRESENCE_STATES is exactly the CHECK the database enforces", () => {
    assert.deepEqual(
      clientList("PRESENCE_STATES").sort(),
      checkVocabulary(m2767, "trip_presence_state_known").sort(),
    );
  });

  it("PRESENCE_SOURCES is exactly 2767's source vocabulary", () => {
    assert.deepEqual(
      clientList("PRESENCE_SOURCES").sort(),
      checkVocabulary(m2767, "trip_presence_source_known").sort(),
    );
  });

  it("PRESENCE_FRESHNESS is exactly what trip_presence_freshness can return", () => {
    const fn = m2776.slice(
      m2776.indexOf("CREATE OR REPLACE FUNCTION public.trip_presence_freshness"),
      m2776.indexOf("COMMENT ON FUNCTION public.trip_presence_freshness"),
    );
    const produced = new Set([...fn.matchAll(/THEN '([a-z_]+)'|ELSE '([a-z_]+)'/g)]
      .map((x) => x[1] ?? x[2]!));
    assert.deepEqual(clientList("PRESENCE_FRESHNESS").sort(), [...produced].sort());
  });

  it("the client sends the payload keys the kernel actually reads", () => {
    const kernel = readFileSync(
      new URL("../migrations/2768_trip_kernel_presence_proposal_outcome_families.sql", import.meta.url),
      "utf8",
    );
    for (const key of ["presence_state", "observed_at", "expires_at", "ttl_seconds", "visibility", "source", "confidence"]) {
      assert.ok(kernel.includes(`v_payload->>'${key}'`), `2768 does not read ${key}; the client sends it`);
      assert.ok(client.includes(`${key}:`), `the client does not send ${key}`);
    }
  });

  it("the client refuses a presence write with no TTL, rather than letting the kernel do it", () => {
    // §10.1: presence has a TTL, and a row without one never goes stale. The
    // kernel enforces it; the client says so where the mistake was made.
    assert.match(client, /expiresAt or ttlSeconds is required/);
  });
});

describe("the route is reachable", () => {
  it("is registered in the router index", () => {
    // A route file that exists and is never mounted is the "built but not
    // wired" case this whole pass is about, one level up.
    const index = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");
    assert.match(index, /import tripPresenceRouter from "\.\/tripPresence"/);
    assert.match(index, /router\.use\(tripPresenceRouter\)/);
  });
});
