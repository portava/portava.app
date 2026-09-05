/**
 * §12 "What Portava Remembers" — route-level tests for the PRIVATE, owner-only
 * Passport remembers surface and its per-item controls.
 *
 * Mounts the real compass router and drives:
 *   GET  /api/compass/me/passport/remembers
 *   POST /api/compass/me/passport/remembers/forget
 *   POST /api/compass/me/passport/remembers/correct
 *
 * Proves the four things that matter for a privacy-critical transparency surface:
 *   1. ALLOW-listed classes are surfaced; every DENY-listed class is omitted
 *      (sensitive-inferred, expired, hidden-state, raw-location, unconsented
 *      shared moment) — asserted via the route's defence-in-depth deny gate.
 *   2. OWNER-ONLY: the caller only ever sees their OWN data; a smuggled ?user_id=
 *      is ignored — the session id is what reaches the store.
 *   3. Every surfaced item carries view-source + correct + forget + visibility.
 *   4. FORGET removes the item AND blocks regeneration: with a 'forget' recorded,
 *      the item stays gone even when the projector re-emits it (the RPC still
 *      returns it) — and the MUTATION (remove the forget) makes it reappear (RED).
 *
 * Run: node --import tsx/esm --test src/test/memoryPassportRemembers.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-00000000ae01";
const MALLORY = "bad00000-0000-0000-0000-00000000bad0";
const FOREIGN_PROJECTION = "11111111-2222-3333-4444-555555555555";
const OWN_PROJECTION     = "99999999-8888-7777-6666-555555555555";

type RpcCall = { name: string; params: any };
let rpcCalls: RpcCall[] = [];
let inserts: Array<{ table: string; row: any }> = [];

interface Seed {
  derived?: any[];               // rows memory_remembers_for_user returns
  feedback?: any[];              // memory_feedback rows (suppressions)
  profile?: Record<string, unknown> | null;
  prefs?: Record<string, unknown> | null;
  savedPlaces?: any[];
  memories?: any[];
  postcards?: any[];
  userStamps?: any[];
  trips?: any[];
  compassMemories?: any[];
  memberships?: any[];
  moments?: any[];
  availability?: Record<string, unknown> | null;
  /**
   * Rows that EXIST in memory_projections. The fake applies the route's own
   * `.eq()` filters to them, so OWNERSHIP is decided by the production filter
   * rather than by the fixture.
   */
  projections?: Array<Record<string, unknown>>;
  rpcError?: string;
  insertError?: { code?: string; message?: string } | null;
}

function makeClient(seed: Seed = {}) {
  // profiles must satisfy BOTH requireUser (account_status) and buildProfileFacts.
  const profileRow = seed.profile === null
    ? null
    : { account_status: "active", ...(seed.profile ?? {}) };

  const listFor = (table: string): any[] => {
    switch (table) {
      case "memory_feedback": return seed.feedback ?? [];
      case "saved_places": return seed.savedPlaces ?? [];
      case "memories": return seed.memories ?? [];
      case "passport_postcards": return seed.postcards ?? [];
      case "user_stamps": return seed.userStamps ?? [];
      case "trips": return seed.trips ?? [];
      case "compass_memories": return seed.compassMemories ?? [];
      case "shared_moment_memberships": return seed.memberships ?? [];
      case "shared_moments": return seed.moments ?? [];
      default: return [];
    }
  };
  const singleFor = (table: string): any => {
    switch (table) {
      case "profiles": return profileRow;
      case "compass_user_preferences": return seed.prefs ?? null;
      case "user_availability": return seed.availability ?? null;
      default: return null;
    }
  };

  return {
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, string> = { "alice-token": ALICE };
        const id = map[token] ?? null;
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "not authed" } };
      },
    },
    rpc: async (name: string, params: any) => {
      rpcCalls.push({ name, params });
      if (seed.rpcError === name) return { data: null, error: { message: "boom" } };
      if (name === "memory_remembers_for_user") return { data: seed.derived ?? [], error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      // `.eq()` RECORDS its filters, and the memory_projections lookup APPLIES
      // them. resolveOwnedProjection enforces ownership with
      // `.eq("user_id", userId)` against the service_role client, which
      // bypasses RLS — so that one line is the only thing between a guessed
      // uuid and forgetting or "correcting" another user's memory. A fake with
      // `eq: () => chain` cannot tell an enforced gate from a deleted one, and
      // the ownership test below was passing on a hard-coded `projection: null`
      // that no filter had to produce.
      const filters: Array<[string, unknown]> = [];
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return chain; },
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (table === "memory_projections") {
            const rows = seed.projections ?? [];
            const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
            return { data: match ?? null, error: null };
          }
          return { data: singleFor(table), error: null };
        },
        insert: async (row: any) => {
          inserts.push({ table, row });
          return { data: null, error: seed.insertError ?? null };
        },
        then: (onF: any, onR: any) =>
          Promise.resolve({ data: listFor(table), error: null }).then(onF, onR),
      };
      return chain;
    },
  } as any;
}

let app: Express;
let server: Server;
let port: number;

before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
});

beforeEach(() => {
  rpcCalls = [];
  inserts = [];
});

async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token: string | null = "alice-token",
): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed };
}

function allItems(surface: any): any[] {
  return (surface.groups ?? []).flatMap((g: any) => g.items ?? []);
}
function groupItems(surface: any, group: string): any[] {
  return (surface.groups ?? []).find((g: any) => g.group === group)?.items ?? [];
}

// A derived row as memory_remembers_for_user would return it.
function derivedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    memory_type: "episodic",
    subject_type: "city",
    subject_id: "Lisbon",
    content: "Visited Lisbon",
    confidence: 0.8,
    is_inferred: false,
    observation_count: 0,
    sensitivity: "normal",
    visibility: "private",
    state: "active",
    retention_class: "durable_fact",
    valid_from: new Date().toISOString(),
    valid_to: null,
    last_supported_at: new Date().toISOString(),
    derivation: "compass_graph_edges:visited",
    source_event_ids: ["aaaaaaaa-1111-1111-1111-111111111111"],
    ...over,
  };
}

describe("GET /compass/me/passport/remembers — auth + owner-only", () => {
  it("requires authentication", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("GET", "/compass/me/passport/remembers", undefined, null);
    assert.ok(res.status === 401 || res.status === 403, `expected auth failure, got ${res.status}`);
    assert.deepEqual(rpcCalls, [], "an unauthenticated request must not reach the store");
  });

  it("uses the SESSION identity, ignoring a smuggled ?user_id=", async () => {
    _setTestClient(makeClient({ derived: [derivedRow()] }), true as any);
    const res = await api("GET", `/compass/me/passport/remembers?user_id=${MALLORY}&p_user_id=${MALLORY}`);
    assert.equal(res.status, 200);
    const call = rpcCalls.find((c) => c.name === "memory_remembers_for_user");
    assert.ok(call, "the remembers RPC should have been called");
    assert.equal(call!.params.p_user_id, ALICE, "must read the caller's OWN memory");
    assert.notEqual(call!.params.p_user_id, MALLORY);
    assert.equal(res.body.ownerId, ALICE);
    assert.equal(res.body.visibility, "owner_only");
  });
});

describe("allow-list is surfaced", () => {
  it("surfaces derived memory, profile facts, preferences, saved content, availability", async () => {
    _setTestClient(makeClient({
      derived: [
        derivedRow(),
        derivedRow({ id: "22222222-2222-2222-2222-222222222222", memory_type: "semantic",
          subject_type: "inferred_interest", subject_id: "food", content: "Often chooses food",
          is_inferred: true, observation_count: 5, retention_class: "derived_preference" }),
      ],
      profile: { home_city: "Miami", home_country: "USA", display_name: "Al", bio: "traveler" },
      prefs: { interests: ["hiking"], travel_styles: ["budget"] },
      savedPlaces: [{ id: "sp1", place_id: "pl1", saved_at: new Date().toISOString() }],
      availability: { open_to_meet: true, strict_mode: false, weekly_days: {} },
    }), true as any);
    const res = await api("GET", "/compass/me/passport/remembers");
    assert.equal(res.status, 200);
    assert.ok(groupItems(res.body, "derived_memory").length >= 2, "derived memory present");
    assert.ok(groupItems(res.body, "profile").some((i) => i.title === "Home base"), "home base present");
    assert.ok(groupItems(res.body, "preferences").some((i) => i.title === "hiking"), "interest present");
    assert.ok(groupItems(res.body, "saved_content").some((i) => i.label === "Saved place"), "saved place present");
    assert.ok(groupItems(res.body, "availability").length === 1, "availability present");

    const inferred = groupItems(res.body, "derived_memory").find((i) => i.isInferred);
    assert.ok(inferred, "the inferred preference is surfaced");
    assert.ok(/inferred/i.test(inferred.inferredNote ?? ""), "inferred item is CLEARLY LABELED as inferred");
    assert.ok(inferred.source.observationCount === 5, "inferred item carries its supporting evidence count");
  });
});

describe("deny-list is omitted (defence-in-depth gate)", () => {
  it("omits sensitive, expired, hidden-state, and sensitive-category-inferred derived rows", async () => {
    _setTestClient(makeClient({
      derived: [
        derivedRow({ id: "keep", subject_id: "Lisbon" }), // allowed control
        derivedRow({ id: "sensitive", sensitivity: "sensitive", subject_id: "co-present-with-X" }),
        derivedRow({ id: "expired", valid_to: new Date(Date.now() - 60_000).toISOString(), subject_id: "Rome" }),
        derivedRow({ id: "hidden", state: "hidden", subject_id: "Oslo" }),
        derivedRow({ id: "sens-infer", is_inferred: true, memory_type: "semantic",
          subject_type: "inferred_interest", subject_id: "sexual_health", content: "Often chooses sexual_health" }),
      ],
    }), true as any);
    const res = await api("GET", "/compass/me/passport/remembers");
    const ids = groupItems(res.body, "derived_memory").map((i) => i.id);
    assert.ok(ids.includes("keep"), "the allowed row is surfaced");
    for (const denied of ["sensitive", "expired", "hidden", "sens-infer"]) {
      assert.ok(!ids.includes(denied), `deny-listed row '${denied}' must be omitted`);
    }
  });

  it("never surfaces raw location trails — no such group or subject is ever read", async () => {
    _setTestClient(makeClient({ derived: [derivedRow()] }), true as any);
    const res = await api("GET", "/compass/me/passport/remembers");
    const items = allItems(res.body);
    assert.ok(!items.some((i) => /location_snapshot|raw|trail|proximity/i.test(i.subjectType + i.source?.originTable)),
      "no raw-location item is present");
    // The DERIVED 'visited' memory is fine and IS present.
    assert.ok(groupItems(res.body, "derived_memory").some((i) => i.title === "Visited Lisbon"));
  });

  it("omits UNCONSENTED shared moments; surfaces only accepted-membership active ones", async () => {
    _setTestClient(makeClient({
      memberships: [
        { moment_id: "m-yes", status: "accepted" },
        { moment_id: "m-invited", status: "invited" },   // not consented
        { moment_id: "m-archived", status: "accepted" },
      ],
      // FIXTURE CORRECTED to the real schema. These rows used to carry
      // `visibility: "circle"`. shared_moments has no `visibility` column at
      // all (and no "circle" anywhere): its audience control is `join_policy`
      // (invite_only | approval_required). The old fixture made this test pass
      // against a select that fails 42703 in production, so the shared-moment
      // group has never rendered a row for a real user.
      moments: [
        { id: "m-yes", title: "Dinner in Da Nang", status: "active", join_policy: "invite_only", archived_at: null },
        { id: "m-invited", title: "Should not appear", status: "active", join_policy: "invite_only", archived_at: null },
        { id: "m-archived", title: "Old moment", status: "archived", join_policy: "approval_required", archived_at: new Date().toISOString() },
      ],
    }), true as any);
    const res = await api("GET", "/compass/me/passport/remembers");
    const surfaced = groupItems(res.body, "shared_moment");
    const titles = surfaced.map((i) => i.title);
    assert.deepEqual(titles, ["Dinner in Da Nang"], "only the accepted + active moment is surfaced");
    assert.equal(surfaced[0].visibility, "invite_only",
      "the moment's audience is reported from its real join_policy, never 'public'");
  });
});

describe("every surfaced item carries all four controls", () => {
  it("view-source, correct, forget, and visibility are present on every item", async () => {
    _setTestClient(makeClient({
      derived: [derivedRow(), derivedRow({ id: "inf", is_inferred: true, memory_type: "semantic",
        subject_type: "inferred_interest", subject_id: "food", content: "Often chooses food" })],
      profile: { home_city: "Miami", display_name: "Al" },
      prefs: { interests: ["hiking"] },
      savedPlaces: [{ id: "sp1", place_id: "pl1", saved_at: new Date().toISOString() }],
      postcards: [{ id: "pc1", caption: "Beach", status: "active", visibility: "private", deleted_at: null, created_at: new Date().toISOString() }],
      availability: { open_to_meet: true },
    }), true as any);
    const res = await api("GET", "/compass/me/passport/remembers");
    const items = allItems(res.body);
    assert.ok(items.length >= 5);
    for (const i of items) {
      assert.equal(i.controls.viewSource, true, `viewSource on ${i.id}`);
      assert.ok(i.source && (i.source.derivation || i.source.originTable), `source provenance on ${i.id}`);
      assert.ok(i.controls.correct && typeof i.controls.correct.supported === "boolean", `correct on ${i.id}`);
      assert.ok(i.controls.forget && i.controls.forget.behavior, `forget on ${i.id}`);
      assert.ok(typeof i.visibility === "string" && i.visibility.length > 0, `visibility on ${i.id}`);
    }
    // Derived items are correctable; user-created source content is not.
    const inf = groupItems(res.body, "derived_memory").find((i) => i.id === "inf");
    assert.equal(inf.controls.correct.supported, true, "an inferred preference is correctable");
    const place = groupItems(res.body, "saved_content").find((i) => i.label === "Saved place");
    assert.equal(place.controls.correct.supported, false, "a saved place is not 'corrected' — edited at source");
    assert.equal(place.controls.forget.behavior, "suppress_from_view", "forgetting a saved place is non-destructive");
  });
});

describe("FORGET removes the item and blocks regeneration", () => {
  it("with a forget recorded, a re-emitted (re-projected) memory stays gone; removing the forget makes it reappear (mutation ⇒ RED)", async () => {
    // The RPC keeps returning the item — modelling the projector RE-CREATING it
    // on its next pass. What keeps it out of the surface is the durable 'forget'.
    const withForget = makeClient({
      derived: [derivedRow({ id: "X", subject_type: "city", subject_id: "Lisbon" })],
      feedback: [{ kind: "forget", subject_type: "city", subject_id: "Lisbon", projection_id: null }],
    });
    _setTestClient(withForget, true as any);
    let res = await api("GET", "/compass/me/passport/remembers");
    let ids = groupItems(res.body, "derived_memory").map((i) => i.id);
    assert.ok(!ids.includes("X"), "a forgotten memory does NOT reappear after re-projection");

    // MUTATION: drop the no-regen signal (empty feedback). If suppression were
    // not load-bearing this would still hide X; instead X reappears — proving the
    // forget is exactly what blocks regeneration.
    const withoutForget = makeClient({
      derived: [derivedRow({ id: "X", subject_type: "city", subject_id: "Lisbon" })],
      feedback: [],
    });
    _setTestClient(withoutForget, true as any);
    res = await api("GET", "/compass/me/passport/remembers");
    ids = groupItems(res.body, "derived_memory").map((i) => i.id);
    assert.ok(ids.includes("X"), "MUTATION CHECK: without the forget the re-projected memory reappears (RED)");
  });

  it("forget on derived memory records a durable subject-keyed signal and never deletes source", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("POST", "/compass/me/passport/remembers/forget", {
      subjectType: "city", subjectId: "Lisbon", memoryType: "episodic",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.behavior, "suppress_no_regen");
    assert.equal(res.body.sourceDeleted, false);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].table, "memory_feedback");
    assert.equal(inserts[0].row.user_id, ALICE, "always keyed to the session identity");
    assert.equal(inserts[0].row.kind, "forget");
    assert.equal(inserts[0].row.subject_id, "Lisbon");
    assert.equal(inserts[0].row.memory_type, "episodic");
  });

  it("forget on user-created source content is non-destructive (suppress_from_view)", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("POST", "/compass/me/passport/remembers/forget", {
      subjectType: "passport:postcard", subjectId: "pc1",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.behavior, "suppress_from_view");
    assert.equal(res.body.sourceDeleted, false);
    assert.equal(inserts[0].row.subject_type, "passport:postcard");
  });

  it("a projection id the caller does not own is rejected (no cross-user suppression)", async () => {
    // The projection EXISTS and belongs to Mallory. resolveOwnedProjection
    // reads through the service_role client (RLS bypassed), so its
    // `.eq("user_id", userId)` is the only barrier. Delete that line and this
    // goes RED: the row resolves and Alice suppresses Mallory's memory.
    _setTestClient(makeClient({
      projections: [{
        id: FOREIGN_PROJECTION, user_id: MALLORY,
        memory_type: "semantic", subject_type: "city", subject_id: "Lisbon",
      }],
    }), true as any);
    const res = await api("POST", "/compass/me/passport/remembers/forget", {
      projectionId: FOREIGN_PROJECTION,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(inserts, [], "no feedback written for a foreign projection");
  });

  it("the caller's OWN projection IS forgettable (positive control)", async () => {
    // Without this, a route that rejected every projection id would also pass
    // the test above.
    _setTestClient(makeClient({
      projections: [{
        id: OWN_PROJECTION, user_id: ALICE,
        memory_type: "episodic", subject_type: "city", subject_id: "Porto",
      }],
    }), true as any);
    const res = await api("POST", "/compass/me/passport/remembers/forget", {
      projectionId: OWN_PROJECTION,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.behavior, "suppress_no_regen");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].row.user_id, ALICE);
    assert.equal(inserts[0].row.subject_id, "Porto",
      "the owned projection's durable subject key is denormalised onto the signal");
  });

  it("forget is idempotent — a duplicate (23505) still reports success", async () => {
    _setTestClient(makeClient({ insertError: { code: "23505", message: "dup" } }), true as any);
    const res = await api("POST", "/compass/me/passport/remembers/forget", {
      subjectType: "city", subjectId: "Lisbon",
    });
    assert.equal(res.status, 201);
  });
});

describe("CORRECT records the corrected value and suppresses the wrong one", () => {
  it("correct on a derived/inferred item writes kind=incorrect + corrected_value", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("POST", "/compass/me/passport/remembers/correct", {
      subjectType: "inferred_interest", subjectId: "food", memoryType: "semantic",
      correctedValue: "actually I prefer nightlife",
    });
    assert.equal(res.status, 201);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].row.kind, "incorrect");
    assert.equal(inserts[0].row.corrected_value, "actually I prefer nightlife");
    assert.equal(inserts[0].row.user_id, ALICE);
  });

  it("correct rejects user-created source content (edited at source, not corrected)", async () => {
    _setTestClient(makeClient(), true as any);
    const res = await api("POST", "/compass/me/passport/remembers/correct", {
      subjectType: "passport:saved_place", subjectId: "sp1", correctedValue: "x",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(inserts, []);
  });

  it("requires a corrected value and a target", async () => {
    _setTestClient(makeClient(), true as any);
    const missingValue = await api("POST", "/compass/me/passport/remembers/correct", {
      subjectType: "inferred_interest", subjectId: "food",
    });
    assert.equal(missingValue.status, 400);
    const missingTarget = await api("POST", "/compass/me/passport/remembers/correct", {
      correctedValue: "x",
    });
    assert.equal(missingTarget.status, 400);
  });
});
