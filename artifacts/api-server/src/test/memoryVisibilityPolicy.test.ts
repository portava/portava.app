/**
 * §3 `memory_visibility_policies` (migration 3810) — the owner's per-Memory
 * ceiling on §10's person ladder, its writer, its readers, and the owner's
 * visibility status. Census-highlights-memories H33; B58 cluster MEM-POLICY.
 *
 * What these tests hold, each failing without the behaviour:
 *   P   the ceiling NEVER widens: over every (derived rung × ceiling ×
 *       crew/not crew) triple the disclosure under a ceiling is at most the
 *       disclosure without it AND at most the ceiling's own; and it is TIGHT
 *       (a most-permissive participant lands exactly on the ceiling)
 *   R1  owner sets ANONYMOUS_COUNT (PUT) ⇒ a permitted viewer of the Memory gets
 *       a count and no participant id, on the detail and on the tags list
 *   R2  an unreadable policy ⇒ HIDDEN for every non-owner (no id, no count); the
 *       owner is unaffected; the participant still sees their own tag
 *   R3  3810 not applied (42P01 / PGRST205) ⇒ byte-identical to no ceiling
 *   R4  a non-owner PUT/GET is the same 404 as a Memory that does not exist
 *   R5  the trip recap (several Memories, one owner) applies each Memory's own ceiling
 *   R6  the crew search's shared derivative carries no id a ceiling hides, so
 *       its `people` filter cannot find a hidden person either
 *
 * Run: node --import tsx/esm --test src/test/memoryVisibilityPolicy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import visibilityPolicyRouter from "../routes/memoryVisibilityPolicy.js";
import {
  PERSON_VISIBILITY_LADDER,
  discloseParticipant,
  type PersonVisibilityRung,
} from "../services/highlights/highlightProjectionPolicy.js";
import {
  applyPersonCeiling,
  ceilingFor,
  readPersonCeilings,
  sharedPeopleUnderCeiling,
  CEILING_NOT_READ,
  POLICY_CHUNK,
  type PersonCeilingRead,
} from "../services/memory/memoryVisibilityPolicy.js";
import {
  canSeeParticipant,
  effectiveParticipantRung,
  loadParticipantVisibility,
  participantRungFor,
  projectParticipants,
  type ParticipantFacts,
} from "../services/memory/memoryParticipantVisibility.js";
import { deriveProjection } from "../services/memoryProjections/derivativeRegistry.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const P1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const P2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
const P3 = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
const M_PUB = "11111111-1111-4111-8111-111111111111";
const M_CREW = "22222222-2222-4222-8222-222222222222";
const M_CREW2 = "33333333-3333-4333-8333-333333333333";
const M_GONE = "44444444-4444-4444-8444-444444444444";
const M_OTHER = "55555555-5555-4555-8555-555555555555";
const M_NONE = "66666666-6666-4666-8666-666666666666";
const TRIP = "77777777-7777-4777-8777-777777777777";
const TABLE = "memory_visibility_policies";
const VIEW = "memory_visibility_policy_effective";
const PEOPLE = [P1, P2, P3];

/* ══════════════════════════════════════════════════════════════════════════
 * P — the ceiling only ever narrows (pure)
 * ════════════════════════════════════════════════════════════════════════*/

/** Information a disclosure carries: name+id 3, id 2, a count 1, nothing 0. */
function level(rung: PersonVisibilityRung, viewerIsCrew: boolean): number {
  const d = discloseParticipant({ userId: "u", handle: "h", name: "n" }, rung, { viewerIsCrew });
  switch (d.rung) {
    case "NAMED": return 3;
    case "PROFILE_LINKED":
    case "CREW_ONLY": return 2;
    case "ANONYMOUS_COUNT": return 1;
    default: return 0;
  }
}
const CEILINGS: Array<PersonVisibilityRung | null> = [null, ...PERSON_VISIBILITY_LADDER];

describe("P §10 the owner's ceiling never widens anything", () => {
  it("over every derived rung × ceiling × crew/not-crew: at most the derived disclosure and at most the ceiling's", () => {
    let checked = 0;
    for (const derived of PERSON_VISIBILITY_LADDER) {
      for (const ceiling of CEILINGS) {
        for (const crew of [true, false]) {
          const out = applyPersonCeiling(derived, ceiling, crew);
          assert.ok(level(out, crew) <= level(derived, crew), `${derived} under ${ceiling} for crew=${crew} WIDENED to ${out}`);
          if (ceiling !== null) assert.ok(level(out, crew) <= level(ceiling, crew), `${derived} under ${ceiling} for crew=${crew} exceeds the ceiling (${out})`);
          if (level(derived, crew) === 0) assert.equal(level(out, crew), 0, `a person hidden from this viewer must not become a count (${derived}/${ceiling}/${crew})`);
          checked++;
        }
      }
    }
    assert.equal(checked, 5 * 6 * 2);
  });

  it("the case a rank-min gets wrong: CREW_ONLY outside the crew is HIDDEN, not raised to the ceiling's count", () => {
    assert.equal(level(applyPersonCeiling("CREW_ONLY", "ANONYMOUS_COUNT", false), false), 0);
    assert.equal(applyPersonCeiling("CREW_ONLY", "ANONYMOUS_COUNT", true), "ANONYMOUS_COUNT", "inside the crew the count IS the stricter answer");
    assert.equal(level(applyPersonCeiling("ANONYMOUS_COUNT", "CREW_ONLY", false), false), 0, "a CREW_ONLY ceiling hides even the count from a non-crew viewer");
  });

  it("is TIGHT: the most permissive participant lands exactly on the ceiling, so a ceiling is never ignored", () => {
    for (const ceiling of PERSON_VISIBILITY_LADDER) {
      for (const crew of [true, false]) {
        assert.equal(level(applyPersonCeiling("NAMED", ceiling, crew), crew), level(ceiling, crew), `NAMED under ${ceiling}, crew=${crew}`);
      }
    }
  });

  it("no ceiling returns the derived rung UNCHANGED (the pre-3810 answer)", () => {
    for (const derived of PERSON_VISIBILITY_LADDER) for (const crew of [true, false]) assert.equal(applyPersonCeiling(derived, null, crew), derived);
  });

  it("over every participant fact set: binds strangers, crew and blocked alike; never the owner; never the participant themself", () => {
    let n = 0;
    for (const tagStatus of ["approved", "pending", "removed", "bogus", null]) {
      for (const memoryVisibility of ["public", "trip_crew", "only_me"]) {
        for (const viewerId of [OWNER, STRANGER, CREW, P1]) {
          for (const viewerBlocked of [false, true]) {
            for (const participantNameAllowed of [false, true]) {
              for (const ownerCeiling of CEILINGS) {
                const viewerIsCrew = viewerId === CREW || viewerId === OWNER;
                const facts: ParticipantFacts = {
                  memoryOwnerId: OWNER, memoryVisibility, viewerId, participantId: P1, tagStatus,
                  viewerIsCrew, viewerBlocked: viewerId === P1 ? false : viewerBlocked, participantNameAllowed, ownerCeiling,
                };
                const derived = participantRungFor(facts);
                const eff = effectiveParticipantRung(facts);
                assert.ok(level(eff, viewerIsCrew) <= level(derived, viewerIsCrew), `widened: ${JSON.stringify(facts)}`);
                if (viewerId === OWNER || viewerId === P1) assert.equal(eff, derived, `the owner and the participant themself are never capped: ${JSON.stringify(facts)}`);
                else if (ownerCeiling !== null) assert.ok(level(eff, viewerIsCrew) <= level(ownerCeiling, viewerIsCrew), `exceeds ceiling: ${JSON.stringify(facts)}`);
                n++;
              }
            }
          }
        }
      }
    }
    assert.equal(n, 5 * 3 * 4 * 2 * 2 * 6);
  });
});

describe("P the four read states and what each binds a viewer to", () => {
  const ok: PersonCeilingRead = { state: "ok", requested: new Set([M_PUB, M_CREW]), byMemory: new Map([[M_PUB, "ANONYMOUS_COUNT"]]) };
  it("ok: the stored rung; a requested Memory with no row has none; a Memory not read is HIDDEN", () => {
    assert.equal(ceilingFor(ok, M_PUB), "ANONYMOUS_COUNT");
    assert.equal(ceilingFor(ok, M_CREW), null);
    assert.equal(ceilingFor(ok, M_OTHER), "HIDDEN", "a lookup the read cannot answer is not 'no ceiling'");
    assert.equal(ceilingFor(ok, null), "HIDDEN");
  });
  it("absent (3810 not applied) is no ceiling; unreadable and not_read are HIDDEN", () => {
    assert.equal(ceilingFor({ state: "absent", detail: "" }, M_PUB), null);
    assert.equal(ceilingFor({ state: "unreadable", detail: "" }, M_PUB), "HIDDEN");
    assert.equal(ceilingFor(CEILING_NOT_READ, M_PUB), "HIDDEN");
  });
  it("a shared (crew) derivative keeps ids under NAMED / PROFILE_LINKED / CREW_ONLY and none under a count or HIDDEN", () => {
    for (const c of [null, "NAMED", "PROFILE_LINKED", "CREW_ONLY"] as const) assert.deepEqual(sharedPeopleUnderCeiling([P1, P2], c), [P1, P2], String(c));
    for (const c of ["ANONYMOUS_COUNT", "HIDDEN"] as const) assert.deepEqual(sharedPeopleUnderCeiling([P1, P2], c), [], c);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * A fake PostgREST client
 * ════════════════════════════════════════════════════════════════════════*/

interface FakeOpts {
  /** 42P01 for these tables (a migration not applied). */
  absent?: Set<string>;
  /** PGRST205 for these tables (not in PostgREST's schema cache). */
  absentCache?: Set<string>;
  /** A database error (57014) on READS of these tables. */
  failReads?: Set<string>;
  /** The client THROWS on reads of these tables. */
  throwReads?: Set<string>;
  /** `${table}:${mode}` writes that fail. */
  failWrites?: Set<string>;
}

function makeClient(store: Record<string, any[]>, opts: FakeOpts, queries: Array<{ table: string; ids?: number }>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, head = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "upsert" | "update" | "delete" | null = null;
    let payload: any = null;
    let conflict: string[] = [];
    let inSize: number | undefined;
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; if (isWrite) selectedAfterWrite = true; return obj; },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any, o?: any) { isWrite = true; mode = "upsert"; payload = d; conflict = String(o?.onConflict ?? "id").split(",").map((c) => c.trim()).filter(Boolean); return obj; },
      delete() { isWrite = true; mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { inSize = vs.length; const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      contains(c: string, vs: any[]) { filters.push((r) => (vs as any[]).every((v) => (r[c] ?? []).includes(v))); return obj; },
      overlaps() { return obj; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      gte() { return obj; }, lte() { return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; }, match() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (!isWrite) queries.push({ table, ids: inSize });
      if (opts.absent?.has(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` }, count: null };
      if (opts.absentCache?.has(table)) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` }, count: null };
      if (!isWrite && opts.throwReads?.has(table)) throw new Error(`${table}: socket hang up`);
      if (!isWrite && opts.failReads?.has(table)) return { data: null, error: { code: "57014", message: `${table} read failed` }, count: null };
      if (isWrite && opts.failWrites?.has(`${table}:${mode}`)) return { data: null, error: { code: "57014", message: `${table} ${mode} failed` }, count: null };
      if (table === VIEW && !isWrite) return viewRows();
      const all = (store[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r }));
        const out: any[] = [];
        for (const r of rows) {
          const existing = mode === "upsert" && conflict.length ? all.find((e: any) => conflict.every((c) => e[c] === r[c])) : undefined;
          if (existing) { Object.assign(existing, r); out.push(existing); }
          else { const stored = { ...r, id: r.id ?? `new-${all.length}-${table}` }; all.push(stored); out.push(stored); }
        }
        return { data: single ? out[0] : out, error: null, count: out.length };
      }
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        const gone = new Set(matched);
        store[table] = all.filter((r) => !gone.has(r));
        return selectedAfterWrite ? { data: matched, error: null, count: matched.length } : { data: null, error: null, count: null };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        return selectedAfterWrite ? { data: matched, error: null, count: matched.length } : { data: null, error: null, count: null };
      }
      if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null, count: null };
      return { data: matched.map((x) => ({ ...x })), error: null, count: head ? matched.length : null };
    }
    /** 3810's view, as the SQL defines it: memories LEFT JOIN the policies. */
    function viewRows(): any {
      if (opts.absent?.has(TABLE)) return { data: null, error: { code: "42P01", message: `relation "public.${VIEW}" does not exist` }, count: null };
      if (opts.failReads?.has(TABLE)) return { data: null, error: { code: "57014", message: `${VIEW} read failed` }, count: null };
      const rows = (store.memories ?? []).map((m: any) => {
        const p = (store[TABLE] ?? []).find((x: any) => x.memory_id === m.id);
        return {
          memory_id: m.id, owner_id: m.owner_id, visibility: m.visibility, allowed_user_ids: m.allowed_user_ids, hidden_user_ids: m.hidden_user_ids,
          location_precision: m.location_precision ?? "exact", person_visibility_ceiling: p?.person_visibility_ceiling ?? null,
          person_visibility_ceiling_updated_at: p?.updated_at ?? null,
        };
      }).filter((r: any) => filters.every((f) => f(r)));
      return single ? { data: rows[0] ?? null, error: null, count: null } : { data: rows, error: null, count: null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    rpc: async () => ({ data: null, error: { message: "no rpc", code: "PGRST202" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "Rooftop in Lisbon", caption: null, visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null, location_city: "Lisbon", location_country: "PT", location_lat: null, location_lng: null,
    canonical_location_id: null, starts_at: "2026-01-02T10:00:00.000Z", ends_at: null, state: "published",
    created_at: "2026-01-02T10:00:00.000Z", updated_at: "2026-01-02T10:00:00.000Z", ...over,
  };
}

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    memories: [
      memory(M_PUB),
      memory(M_CREW, { visibility: "trip_crew", trip_id: TRIP, title: "Porto crew dinner" }),
      memory(M_CREW2, { visibility: "trip_crew", trip_id: TRIP, title: "Porto morning" }),
      memory(M_GONE, { state: "deleted" }),
      memory(M_OTHER, { owner_id: STRANGER, title: "the stranger's own" }),
    ],
    memory_items: [],
    memory_tags: [
      { memory_id: M_PUB, tagged_user_id: P1, status: "approved", created_at: "2026-01-02T10:00:00.000Z" },
      { memory_id: M_PUB, tagged_user_id: P2, status: "approved", created_at: "2026-01-02T10:00:00.000Z" },
      { memory_id: M_PUB, tagged_user_id: P3, status: "pending", created_at: "2026-01-02T10:00:00.000Z" },
      { memory_id: M_CREW, tagged_user_id: P1, status: "approved", created_at: "2026-01-02T10:00:00.000Z" },
      { memory_id: M_CREW2, tagged_user_id: P2, status: "approved", created_at: "2026-01-02T10:00:00.000Z" },
    ],
    [TABLE]: [],
    memory_derivative_registry: [],
    profiles: [OWNER, STRANGER, CREW, P1, P2, P3].map((id, i) => ({ id, account_status: "active", name: `Person ${i}`, handle: `h${i}`, avatar_url: null })),
    profile_privacy_settings: [],
    blocks: [],
    trips: [{ id: TRIP, owner_id: OWNER }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: CREW, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: P1, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: P2, role: "member", status: "accepted" },
    ],
  };
}

interface App { base: string; store: Record<string, any[]>; queries: Array<{ table: string; ids?: number }>; logged: any[]; close: () => Promise<void> }
async function start(opts: FakeOpts = {}, store: Record<string, any[]> = seed()): Promise<App> {
  const queries: Array<{ table: string; ids?: number }> = [];
  _setTestClient(makeClient(store, opts, queries) as any, true);
  const logged: any[] = [];
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: (o: any, m: string) => logged.push({ o, m }), info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoriesRouter);
  app.use("/api", visibilityPolicyRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  srv.unref();
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, queries, logged, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
async function call(a: App, method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(`${a.base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, text };
}
async function withApp<T>(fn: (a: App) => Promise<T>, opts: FakeOpts = {}, store?: Record<string, any[]>): Promise<T> {
  const a = await start(opts, store);
  try { return await fn(a); } finally { await a.close(); }
}
const tagIds = (b: any) => ((b?.memory?.tags ?? b?.tags ?? []) as any[]).map((t) => t.userId).sort();
const anon = (b: any) => b?.memory?.anonymousParticipants ?? b?.anonymousParticipants;
const mentions = (text: string, ids: readonly string[]) => ids.filter((id) => text.includes(id));
function withCeiling(memoryId: string, rung: string, ownerId = OWNER): Record<string, any[]> {
  const s = seed();
  s[TABLE] = [{ memory_id: memoryId, owner_id: ownerId, person_visibility_ceiling: rung, updated_at: "2026-10-14T00:00:00.000Z" }];
  return s;
}

/* ══════════════════════════════════════════════════════════════════════════
 * R1 — owner sets ANONYMOUS_COUNT ⇒ a permitted viewer gets a count, no ids
 * ════════════════════════════════════════════════════════════════════════*/

describe("R1 the owner's ceiling ANONYMOUS_COUNT: a permitted viewer gets a count and no ids", () => {
  it("baseline (no ceiling): the stranger sees the two approved people by id and the pending one as a count", async () => {
    await withApp(async (a) => {
      const r = await call(a, "GET", `/memories/${M_PUB}`, STRANGER);
      assert.equal(r.status, 200);
      assert.deepEqual(tagIds(r.body), [P1, P2].sort());
      assert.equal(anon(r.body), 1);
    });
  });

  it("a stored ANONYMOUS_COUNT turns every person into the count, on the detail AND the tags list, with no id anywhere", async () => {
    await withApp(async (a) => {
      const d = await call(a, "GET", `/memories/${M_PUB}`, STRANGER);
      assert.equal(d.status, 200);
      assert.deepEqual(tagIds(d.body), []);
      assert.equal(anon(d.body), 3, "three people were there; the viewer may know that, and nothing else");
      assert.deepEqual(mentions(d.text, PEOPLE), [], "no participant id anywhere in the response");
      const t = await call(a, "GET", `/memories/${M_PUB}/tags`, STRANGER);
      assert.equal(t.status, 200);
      assert.deepEqual(tagIds(t.body), []);
      assert.equal(anon(t.body), 3);
      assert.deepEqual(mentions(t.text, PEOPLE), []);
    }, {}, withCeiling(M_PUB, "ANONYMOUS_COUNT"));
  });

  it("END TO END: the owner PUTs the ceiling, and the stranger's next read obeys it", async () => {
    await withApp(async (a) => {
      const put = await call(a, "PUT", `/memories/${M_PUB}/visibility-policy`, OWNER, { personVisibilityCeiling: "ANONYMOUS_COUNT" });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, { memoryId: M_PUB, personVisibilityCeiling: "ANONYMOUS_COUNT" });
      assert.deepEqual(a.store[TABLE].map((r) => [r.memory_id, r.owner_id, r.person_visibility_ceiling]), [[M_PUB, OWNER, "ANONYMOUS_COUNT"]]);
      const d = await call(a, "GET", `/memories/${M_PUB}`, STRANGER);
      assert.deepEqual(tagIds(d.body), []);
      assert.equal(anon(d.body), 3);
      assert.deepEqual(mentions(d.text, PEOPLE), []);
      const cleared = await call(a, "PUT", `/memories/${M_PUB}/visibility-policy`, OWNER, { personVisibilityCeiling: null });
      assert.equal(cleared.status, 200);
      assert.deepEqual(a.store[TABLE], [], "null clears: the row is deleted");
      assert.deepEqual(tagIds((await call(a, "GET", `/memories/${M_PUB}`, STRANGER)).body), [P1, P2].sort(), "cleared: back to the derived ladder");
    });
  });

  it("the OWNER's own view and tag management are unchanged by their ceiling", async () => {
    await withApp(async (a) => {
      const d = await call(a, "GET", `/memories/${M_PUB}`, OWNER);
      assert.deepEqual(tagIds(d.body), PEOPLE.slice().sort());
      assert.equal(anon(d.body), 0);
    }, {}, withCeiling(M_PUB, "HIDDEN"));
  });

  it("HIDDEN shows nobody and counts nobody; CREW_ONLY hides from a non-crew viewer even the pending count", async () => {
    await withApp(async (a) => {
      const d = await call(a, "GET", `/memories/${M_PUB}`, STRANGER);
      assert.deepEqual(tagIds(d.body), []);
      assert.equal(anon(d.body), 0);
      assert.deepEqual(mentions(d.text, PEOPLE), []);
    }, {}, withCeiling(M_PUB, "HIDDEN"));
    await withApp(async (a) => {
      const d = await call(a, "GET", `/memories/${M_PUB}`, STRANGER);
      assert.deepEqual(tagIds(d.body), []);
      assert.equal(anon(d.body), 0, "outside the crew, CREW_ONLY discloses nothing — not even the count a pending tag would give");
    }, {}, withCeiling(M_PUB, "CREW_ONLY"));
  });

  it("§23 canSeeParticipant answers the capped rung", async () => {
    const store = withCeiling(M_PUB, "ANONYMOUS_COUNT");
    const sc = makeClient(store, {}, []);
    assert.equal(await canSeeParticipant(sc, STRANGER, M_PUB, P1), "ANONYMOUS_COUNT");
    assert.equal(await canSeeParticipant(sc, OWNER, M_PUB, P1), "PROFILE_LINKED", "the owner is not capped");
    assert.equal(await canSeeParticipant(makeClient(seed(), {}, []), STRANGER, M_PUB, P1), "PROFILE_LINKED", "no ceiling: the derived rung");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R2 — an unreadable policy ⇒ HIDDEN for non-owners; owner unaffected
 * ════════════════════════════════════════════════════════════════════════*/

describe("R2 an unreadable policy is the most restrictive rung for everyone but the owner", () => {
  for (const [label, opts, store] of [
    ["a database error", { failReads: new Set([TABLE]) }, seed()],
    ["a thrown read", { throwReads: new Set([TABLE]) }, seed()],
    ["a stored value off the ladder", {}, withCeiling(M_PUB, "SECRET")],
    ["a lower-case rung", {}, withCeiling(M_PUB, "named")],
    ["a row filed under another owner", {}, withCeiling(M_PUB, "NAMED", STRANGER)],
  ] as const) {
    it(`${label}: a stranger gets no id and no count; the owner gets everyone; the participant still sees their own tag`, async () => {
      await withApp(async (a) => {
        const s = await call(a, "GET", `/memories/${M_PUB}`, STRANGER);
        assert.equal(s.status, 200, "the Memory is still served — only its people are withheld");
        assert.deepEqual(tagIds(s.body), []);
        assert.equal(anon(s.body), 0);
        assert.deepEqual(mentions(s.text, PEOPLE), []);
        const o = await call(a, "GET", `/memories/${M_PUB}`, OWNER);
        assert.deepEqual(tagIds(o.body), PEOPLE.slice().sort(), "owner unaffected");
        const self = await call(a, "GET", `/memories/${M_PUB}/tags`, P3);
        assert.equal(self.status, 200);
        assert.deepEqual(tagIds(self.body), [P3], "the pending participant still sees the tag they are asked to approve, and nobody else");
        assert.equal(anon(self.body), 0);
      }, opts as FakeOpts, store as Record<string, any[]>);
    });
  }

  it("§23 canSeeParticipant is HIDDEN on an unreadable policy, and the owner's answer does not even read it", async () => {
    const q: Array<{ table: string }> = [];
    const sc = makeClient(seed(), { failReads: new Set([TABLE]) }, q);
    assert.equal(await canSeeParticipant(sc, STRANGER, M_PUB, P1), "HIDDEN");
    q.length = 0;
    assert.equal(await canSeeParticipant(sc, OWNER, M_PUB, P1), "PROFILE_LINKED");
    assert.equal(q.filter((x) => x.table === TABLE).length, 0);
  });

  it("readPersonCeilings: every failure shape is `unreadable`, never `absent` and never `ok`", async () => {
    for (const code of ["57014", "42501", "42703", "PGRST204", "08006"]) {
      const sc = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { code, message: `relation "${TABLE}" does not exist` } }) }) }) };
      assert.equal((await readPersonCeilings(sc, OWNER, [M_PUB])).state, "unreadable", code);
    }
    const noArray = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: null }) }) }) };
    assert.equal((await readPersonCeilings(noArray, OWNER, [M_PUB])).state, "unreadable");
    const tooMany = { from: () => ({ select: () => ({ in: async () => ({ data: [{ memory_id: M_PUB, owner_id: OWNER, person_visibility_ceiling: "NAMED" }, { memory_id: M_PUB, owner_id: OWNER, person_visibility_ceiling: "NAMED" }], error: null }) }) }) };
    assert.equal((await readPersonCeilings(tooMany, OWNER, [M_PUB])).state, "unreadable");
    const stray = { from: () => ({ select: () => ({ in: async () => ({ data: [{ memory_id: M_OTHER, owner_id: OWNER, person_visibility_ceiling: "NAMED" }], error: null }) }) }) };
    assert.equal((await readPersonCeilings(stray, OWNER, [M_PUB])).state, "unreadable", "a row nobody asked for");
    assert.equal((await readPersonCeilings(stray, OWNER, [])).state, "not_read");
  });

  it("a non-owner context that read no policy (no Memory id given) discloses nobody but the participant themself", async () => {
    const sc = makeClient(seed(), {}, []);
    const ctx = await loadParticipantVisibility(sc, { owner_id: OWNER, visibility: "public", trip_id: null }, STRANGER, PEOPLE);
    assert.equal(ctx.personCeilings.state, "not_read");
    const out = projectParticipants(ctx, [{ tagged_user_id: P1, status: "approved" }, { tagged_user_id: P3, status: "pending" }]);
    assert.deepEqual(out.participants, []);
    assert.equal(out.anonymousCount, 0);
    const selfCtx = await loadParticipantVisibility(sc, { owner_id: OWNER, visibility: "public", trip_id: null }, P1, PEOPLE);
    assert.deepEqual(projectParticipants(selfCtx, [{ tagged_user_id: P1, status: "approved" }]).participants.map((p) => p.userId), [P1]);
    const handBuilt = { ...ctx, personCeilings: undefined as unknown as PersonCeilingRead };
    assert.deepEqual(projectParticipants(handBuilt, [{ tagged_user_id: P1, status: "approved" }]).participants, [], "a context without a policy read is not 'no ceiling'");
  });

  it("readPersonCeilings chunks a large set and reads every chunk", async () => {
    const ids = Array.from({ length: POLICY_CHUNK * 2 + 5 }, (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const store: Record<string, any[]> = { [TABLE]: [{ memory_id: ids[ids.length - 1], owner_id: OWNER, person_visibility_ceiling: "HIDDEN" }] };
    const q: Array<{ table: string; ids?: number }> = [];
    const read = await readPersonCeilings(makeClient(store, {}, q), OWNER, ids);
    assert.equal(read.state, "ok");
    assert.deepEqual(q.map((x) => x.ids), [POLICY_CHUNK, POLICY_CHUNK, 5]);
    assert.equal(ceilingFor(read, ids[ids.length - 1]), "HIDDEN", "a row in the LAST chunk is honoured");
    assert.equal(ceilingFor(read, ids[0]), null);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R3 — 3810 not applied ⇒ exactly today's behaviour
 * ════════════════════════════════════════════════════════════════════════*/

describe("R3 3810 not applied: every surface answers exactly as it did before", () => {
  for (const [label, opts] of [["42P01", { absent: new Set([TABLE]) }], ["PGRST205", { absentCache: new Set([TABLE]) }]] as const) {
    it(`${label}: the detail and the tags list are byte-identical to a deployed table with no ceiling`, async () => {
      const paths = [`/memories/${M_PUB}`, `/memories/${M_PUB}/tags`];
      const viewers = [STRANGER, OWNER, P3];
      const deployed: string[] = [];
      await withApp(async (a) => { for (const p of paths) for (const v of viewers) deployed.push((await call(a, "GET", p, v)).text); });
      const absent: string[] = [];
      await withApp(async (a) => { for (const p of paths) for (const v of viewers) absent.push((await call(a, "GET", p, v)).text); }, opts as FakeOpts);
      assert.deepEqual(absent, deployed);
      assert.ok(deployed[0]!.includes(P1), "and that answer does disclose the approved people (the comparison is not vacuous)");
    });
  }

  it("the owner's PUT and GET say the setting is not available yet, never 'saved' and never 'none'", async () => {
    await withApp(async (a) => {
      const put = await call(a, "PUT", `/memories/${M_PUB}/visibility-policy`, OWNER, { personVisibilityCeiling: "HIDDEN" });
      assert.equal(put.status, 404);
      assert.equal(put.body.error, "feature_disabled");
      const get = await call(a, "GET", `/memories/${M_PUB}/visibility-policy`, OWNER);
      assert.equal(get.status, 404);
      assert.equal(get.body.error, "feature_disabled");
    }, { absent: new Set([TABLE]) });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R4 — the writer and the status: owner only, no existence oracle
 * ════════════════════════════════════════════════════════════════════════*/

describe("R4 PUT/GET /memories/:id/visibility-policy: the owner's, and nobody else's", () => {
  it("a non-owner's PUT is the SAME 404 as a deleted Memory and a Memory that does not exist, and writes nothing", async () => {
    await withApp(async (a) => {
      const body = { personVisibilityCeiling: "NAMED" };
      const foreign = await call(a, "PUT", `/memories/${M_PUB}/visibility-policy`, STRANGER, body);
      const deleted = await call(a, "PUT", `/memories/${M_GONE}/visibility-policy`, OWNER, body);
      const missing = await call(a, "PUT", `/memories/${M_NONE}/visibility-policy`, OWNER, body);
      for (const r of [foreign, deleted, missing]) {
        assert.equal(r.status, 404);
        assert.deepEqual(r.body, { error: "not_found", message: "Memory not found" });
      }
      assert.equal(foreign.text, missing.text, "byte-identical: the answer says nothing about whether the Memory exists");
      assert.deepEqual(a.store[TABLE], []);
    });
  });

  it("a non-owner's GET is the same 404, and reveals no policy", async () => {
    await withApp(async (a) => {
      const foreign = await call(a, "GET", `/memories/${M_PUB}/visibility-policy`, STRANGER);
      const missing = await call(a, "GET", `/memories/${M_NONE}/visibility-policy`, STRANGER);
      assert.equal(foreign.status, 404);
      assert.equal(foreign.text, missing.text);
      assert.ok(!foreign.text.includes("HIDDEN"));
    }, {}, withCeiling(M_PUB, "HIDDEN"));
  });

  it("a participant cannot set the owner's ceiling either", async () => {
    await withApp(async (a) => {
      const r = await call(a, "PUT", `/memories/${M_PUB}/visibility-policy`, P1, { personVisibilityCeiling: "NAMED" });
      assert.equal(r.status, 404);
      assert.deepEqual(a.store[TABLE], []);
    });
  });

  it("refuses a value off the ladder, a missing value, an extra field and a bad id — 400, nothing written", async () => {
    await withApp(async (a) => {
      for (const body of [{ personVisibilityCeiling: "SECRET" }, { personVisibilityCeiling: "named" }, {}, { personVisibilityCeiling: "HIDDEN", visibility: "public" }, { personVisibilityCeiling: 3 }]) {
        const r = await call(a, "PUT", `/memories/${M_PUB}/visibility-policy`, OWNER, body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.error, "invalid_payload");
      }
      assert.equal((await call(a, "PUT", `/memories/not-a-uuid/visibility-policy`, OWNER, { personVisibilityCeiling: "HIDDEN" })).status, 400);
      assert.deepEqual(a.store[TABLE], []);
      assert.equal(a.store.memories.find((m) => m.id === M_PUB)!.visibility, "public", "the audience is never written here");
    });
  });

  it("a failed write is a 503, never a 200", async () => {
    await withApp(async (a) => {
      const r = await call(a, "PUT", `/memories/${M_PUB}/visibility-policy`, OWNER, { personVisibilityCeiling: "HIDDEN" });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "degraded_unavailable");
    }, { failWrites: new Set([`${TABLE}:upsert`]) });
    await withApp(async (a) => {
      const r = await call(a, "PUT", `/memories/${M_PUB}/visibility-policy`, OWNER, { personVisibilityCeiling: null });
      assert.equal(r.status, 503);
      assert.equal(a.store[TABLE].length, 1, "the ceiling still stands");
    }, { failWrites: new Set([`${TABLE}:delete`]) }, withCeiling(M_PUB, "HIDDEN"));
  });

  it("the owner's GET is §12's visibility status: audience and precision from the Memory, the ceiling from 3810", async () => {
    const store = withCeiling(M_PUB, "ANONYMOUS_COUNT");
    store.memories.find((m) => m.id === M_PUB)!.hidden_user_ids = [STRANGER];
    (store.memories.find((m) => m.id === M_PUB) as any).location_precision = "city";
    await withApp(async (a) => {
      const r = await call(a, "GET", `/memories/${M_PUB}/visibility-policy`, OWNER);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.audience, { visibility: "public", allowedUserIds: [], hiddenUserIds: [STRANGER] });
      assert.equal(r.body.locationPrecision.chosen, "city");
      assert.equal(r.body.locationPrecision.enforcement, "off", "memory_location_precision_enabled has no row here: stored, not applied — and the status says so");
      assert.equal(r.body.personVisibility.ceiling, "ANONYMOUS_COUNT");
      assert.equal(r.body.personVisibility.recognised, true);
      const none = await call(a, "GET", `/memories/${M_CREW}/visibility-policy`, OWNER);
      assert.equal(none.body.personVisibility.ceiling, null, "no row = no ceiling");
    }, {}, store);
  });

  it("the owner's GET reports an unrecognised stored value as what others get (HIDDEN), and an unreadable view as 503", async () => {
    await withApp(async (a) => {
      const r = await call(a, "GET", `/memories/${M_PUB}/visibility-policy`, OWNER);
      assert.equal(r.body.personVisibility.ceiling, "HIDDEN");
      assert.equal(r.body.personVisibility.recognised, false);
    }, {}, withCeiling(M_PUB, "SECRET"));
    await withApp(async (a) => {
      const r = await call(a, "GET", `/memories/${M_PUB}/visibility-policy`, OWNER);
      assert.equal(r.status, 503);
    }, { failReads: new Set([TABLE]) });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R5 — the trip recap: several Memories, each with its own ceiling
 * ════════════════════════════════════════════════════════════════════════*/

describe("R5 the trip recap applies each Memory's own ceiling", () => {
  const peopleOf = (b: any, id: string) => ((b?.recap?.rows ?? []) as any[]).find((r) => r.memory_id === id)?.people;
  it("a crew member sees M_CREW's people withheld and M_CREW2's untouched; the owner sees both", async () => {
    await withApp(async (a) => {
      const before = await call(a, "GET", `/trips/${TRIP}/memories/recap`, CREW);
      assert.equal(before.status, 200);
      assert.deepEqual(peopleOf(before.body, M_CREW), [P1], "baseline: the approved participant is on the recap");
    });
    await withApp(async (a) => {
      const r = await call(a, "GET", `/trips/${TRIP}/memories/recap`, CREW);
      assert.equal(r.status, 200);
      assert.deepEqual(peopleOf(r.body, M_CREW), []);
      assert.deepEqual(peopleOf(r.body, M_CREW2), [P2], "the other Memory's people are not affected by M_CREW's ceiling");
      const o = await call(a, "GET", `/trips/${TRIP}/memories/recap`, OWNER);
      assert.deepEqual(peopleOf(o.body, M_CREW), [P1]);
    }, {}, withCeiling(M_CREW, "HIDDEN"));
  });

  it("an unreadable policy withholds every Memory's people from the crew, and nobody's from the owner", async () => {
    await withApp(async (a) => {
      const r = await call(a, "GET", `/trips/${TRIP}/memories/recap`, CREW);
      assert.equal(r.status, 200);
      assert.deepEqual(peopleOf(r.body, M_CREW), []);
      assert.deepEqual(peopleOf(r.body, M_CREW2), []);
      const o = await call(a, "GET", `/trips/${TRIP}/memories/recap`, OWNER);
      assert.deepEqual(peopleOf(o.body, M_CREW2), [P2]);
    }, { failReads: new Set([TABLE]) });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * R6 — §18's shared crew derivative and the crew search
 * ════════════════════════════════════════════════════════════════════════*/

describe("R6 the crew search's shared TripMemoryProjection is built under each owner's ceiling", () => {
  const sharedScope = { owner_id: OWNER, viewer_id: null, trip_id: TRIP, place_id: null, person_id: null };
  const rowPeople = (rows: any[], id: string) => rows.find((r) => r.memory_id === id)?.people;

  it("a HIDDEN ceiling strips that Memory's people at BUILD time; the owner's own build keeps them", async () => {
    const d = await deriveProjection(makeClient(withCeiling(M_CREW, "HIDDEN"), {}, []) as any, "TripMemoryProjection", sharedScope);
    assert.ok(d.ok);
    assert.deepEqual(rowPeople(d.value.rows, M_CREW), []);
    assert.deepEqual(rowPeople(d.value.rows, M_CREW2), [P2]);
    const own = await deriveProjection(makeClient(withCeiling(M_CREW, "HIDDEN"), {}, []) as any, "TripMemoryProjection", { ...sharedScope, viewer_id: OWNER });
    assert.ok(own.ok);
    assert.deepEqual(rowPeople(own.value.rows, M_CREW), [P1]);
  });

  it("an unreadable policy refuses a non-owner build rather than serving people it could not clear", async () => {
    const d = await deriveProjection(makeClient(seed(), { failReads: new Set([TABLE]) }, []) as any, "TripMemoryProjection", sharedScope);
    assert.equal(d.ok, false);
    assert.equal((d as any).table, TABLE);
    const own = await deriveProjection(makeClient(seed(), { failReads: new Set([TABLE]) }, []) as any, "TripMemoryProjection", { ...sharedScope, viewer_id: OWNER });
    assert.ok(own.ok, "the owner's own build is not refused");
  });

  it("absent (3810 not applied): the same rows AND the same source version as a deployed table with no ceiling", async () => {
    const deployed = await deriveProjection(makeClient(seed(), {}, []) as any, "TripMemoryProjection", sharedScope);
    const absent = await deriveProjection(makeClient(seed(), { absent: new Set([TABLE]) }, []) as any, "TripMemoryProjection", sharedScope);
    assert.ok(deployed.ok && absent.ok);
    assert.deepEqual(absent.value.rows, deployed.value.rows);
    assert.equal(absent.value.source_version, deployed.value.source_version, "byte-identical digest: no registered derivative goes stale because 3810 is missing");
    assert.deepEqual(rowPeople(deployed.value.rows, M_CREW), [P1]);
  });

  it("a ceiling set, changed or cleared changes the source version, so a registered derivative is STALE and rebuilt", async () => {
    const v = async (s: Record<string, any[]>) => {
      const d = await deriveProjection(makeClient(s, {}, []) as any, "TripMemoryProjection", sharedScope);
      assert.ok(d.ok);
      return d.value.source_version;
    };
    const none = await v(seed());
    const hidden = await v(withCeiling(M_CREW, "HIDDEN"));
    const count = await v(withCeiling(M_CREW, "ANONYMOUS_COUNT"));
    assert.notEqual(hidden, none);
    assert.notEqual(count, hidden);
  });

  it("END TO END: the crew search returns no id the owner hid, and its people filter cannot find a hidden person", async () => {
    const search = (a: App, actor: string, body: unknown) => call(a, "POST", "/memories/search", actor, body);
    await withApp(async (a) => {
      const base = await search(a, CREW, { intent: { kind: "crew_trip", tripId: TRIP }, people: [P1] });
      assert.equal(base.status, 200);
      assert.ok(base.body.hits.some((h: any) => h.memoryId === M_CREW), "baseline: the filter finds the approved participant");
    });
    await withApp(async (a) => {
      const all = await search(a, CREW, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(all.status, 200);
      const hit = all.body.hits.find((h: any) => h.memoryId === M_CREW);
      assert.ok(hit, "the Memory itself is still searchable by the crew");
      assert.deepEqual(hit.row.people, []);
      assert.deepEqual(mentions(JSON.stringify(all.body.hits), [P1]), []);
      const filtered = await search(a, CREW, { intent: { kind: "crew_trip", tripId: TRIP }, people: [P1] });
      assert.equal(filtered.status, 200);
      assert.ok(!filtered.body.hits.some((h: any) => h.memoryId === M_CREW), "the hidden person is not findable by name");
      assert.equal(filtered.body.deterministicMatchCount, 0, "and no count betrays the match");
    }, {}, withCeiling(M_CREW, "HIDDEN"));
  });

  it("the owner's PUT re-derives a registered crew derivative that carried the Memory", async () => {
    await withApp(async (a) => {
      const search = (actor: string) => call(a, "POST", "/memories/search", actor, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal((await search(CREW)).status, 200);
      const reg = () => a.store.memory_derivative_registry.find((g: any) => g.projection_id === "TripMemoryProjection" && g.owner_id === OWNER && g.viewer_id == null);
      assert.ok(reg(), "the crew search registered the owner's shared derivative");
      assert.ok(JSON.stringify(reg().payload ?? reg().rows ?? reg()).includes(P1), "at rest it names the participant");
      const put = await call(a, "PUT", `/memories/${M_CREW}/visibility-policy`, OWNER, { personVisibilityCeiling: "HIDDEN" });
      assert.equal(put.status, 200);
      assert.ok(!JSON.stringify(reg().payload ?? reg().rows ?? reg()).includes(P1), "re-derived at once (H-4): the stored derivative no longer names them");
    });
  });
});
