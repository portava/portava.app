/**
 * A location share is bound to the purpose it was granted for (migration 3753,
 * census-telegraph T149 / T215 / T356 / T420, RECON-W cluster A1).
 *
 * What these prove, each against the real code path:
 *   - the SQL CHECK in 3753 is the registry's id list, so the two cannot drift;
 *   - the writer (startLiveShare) records the purpose it grants for, and on a
 *     database without the column writes the pre-3753 row instead of failing;
 *   - every reader keeps only rows of the purpose it serves: a share granted for
 *     purpose X is invisible to a reader serving Y — through getCrewMap,
 *     getActiveLiveShares and getViewerOwnPresence;
 *   - a NULL (legacy / pre-3753) row is visible to the crew live-share readers
 *     only (owner decision LSP-1's fail-closed default) and to no other purpose;
 *   - an unknown purpose is refused everywhere; an unreadable purpose is a 503,
 *     never "no shares";
 *   - every source file that names the share store is declared with its
 *     purpose, and the Nearby files never name it.
 *
 * Run: node --import tsx/esm --test src/test/locationSharePurpose.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CREW_LIVE_SHARE_PURPOSE,
  LEGACY_SHARE_CREATOR_PURPOSE,
  LOCATION_SHARE_ACCESS,
  SHARE_PURPOSE_CHECK_IDS,
  SHARE_STORE_FORBIDDEN_READERS,
  SharePurposeUnreadableError,
  admitSharesForPurpose,
  purposesDeclaringShareTable,
  shareAdmittedFor,
} from "../lib/locationSharePurpose.js";
import { LOCATION_PURPOSES } from "../lib/locationPurposes.js";
import { startLiveShare, getActiveLiveShares } from "../domain/trips/services/TripCrewLiveShareService.js";
import { getCrewMap, getViewerOwnPresence, CrewMapUnavailableError } from "../domain/trips/services/TripCrewLocationService.js";
import { invalidateTripOperationalProjectionsGate } from "../domain/trips/policies/tripOperationalProjections.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dir, "..");
const MIGRATION = path.join(SRC, "migrations/3753_location_share_purpose.sql");

type Row = Record<string, any>;
const OTHER = "presence_in_context"; // a real registry purpose that is NOT the crew live share

// ── A fake that honours the filters getCrewMap uses, and can refuse `purpose` ──
interface FakeOpts { purposeColumn?: "present" | "absent" | "error" }
function fake(tables: Record<string, Row[]>, opts: FakeOpts = {}) {
  const inserts: Array<{ table: string; row: Row }> = [];
  const selects: Array<{ table: string; sel: string }> = [];
  const client: any = {
    _inserts: inserts,
    _selects: selects,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let sel = "";
      let pendingInsert: Row | null = null;
      const purposeErr = () => {
        if (table !== "trip_crew_location_sessions") return null;
        const touches = /\bpurpose\b/.test(sel) || (pendingInsert && "purpose" in pendingInsert);
        if (!touches) return null;
        if (opts.purposeColumn === "absent") return { code: "42703", message: "column trip_crew_location_sessions.purpose does not exist" };
        if (opts.purposeColumn === "error") return { code: "57014", message: "canceling statement due to statement timeout" };
        return null;
      };
      let lim: number | null = null;
      const rows = () => { const r = (tables[table] ?? []).filter((x) => filters.every((f) => f(x))); return lim === null ? r : r.slice(0, lim); };
      const result = () => {
        const e = purposeErr();
        if (e) return { data: null, error: e };
        if (pendingInsert) {
          const row = { id: `new-${inserts.length}`, ...pendingInsert };
          inserts.push({ table, row: pendingInsert });
          (tables[table] ??= []).push(row);
          return { data: row, error: null };
        }
        return { data: rows(), error: null };
      };
      const chain: any = {
        select: (s?: string) => { sel = s ?? ""; selects.push({ table, sel }); return chain; },
        insert: (r: Row) => { pendingInsert = r; return chain; },
        update: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        gt: (c: string, v: any) => { filters.push((r) => String(r[c]) > String(v)); return chain; },
        lt: (c: string, v: any) => { filters.push((r) => String(r[c]) < String(v)); return chain; },
        or: () => chain,
        order: () => chain,
        limit: (n: number) => { lim = n; return chain; },
        maybeSingle: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        single: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        then: (onF: any, onR: any) => Promise.resolve(result()).then(onF, onR),
      };
      return chain;
    },
  };
  return client;
}

const TRIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const SHARER = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2031-02-03T08:00:00.000Z");
const MIN = 60_000;

/** The crew of tripCrewMapInjectedClock.test.ts, with the share's purpose as the only variable. */
function crew(purpose: string | null | undefined, extra: Partial<Row> = {}): Record<string, Row[]> {
  const share: Row = {
    id: "s-1", trip_id: TRIP_ID, user_id: SHARER, status: "active",
    expires_at: new Date(NOW + 30 * MIN).toISOString(),
    allowed_member_ids: [VIEWER], visibility_level: "nearby", ...extra,
  };
  if (purpose !== undefined) share.purpose = purpose;
  return {
    feature_flags: [{ flag: "trip_operational_projections_enabled", enabled: false }],
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version: 1 }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: VIEWER, role: "member", status: "accepted" },
      { trip_id: TRIP_ID, user_id: SHARER, role: "member", status: "accepted" },
    ],
    blocks: [],
    profiles: [
      { id: SHARER, username: "sharer", display_name: "Sharer" },
      { id: OWNER_ID, username: "owner", display_name: "Owner" },
    ],
    profile_privacy_settings: [],
    trip_crew_location_preferences: [
      { trip_id: TRIP_ID, user_id: SHARER, default_visibility: "nearby", ghost_mode_enabled: false, share_arrival_status: true, share_safe_return_status: false },
    ],
    user_location_state: [
      { user_id: SHARER, city: "Lisboa", district: "Alfama", country: "PT",
        updated_at: new Date(NOW - MIN).toISOString(), last_known_at: new Date(NOW - MIN).toISOString(),
        lat: 38.71, lng: -9.13, source: "gps", accuracy_meters: 20 },
      { user_id: VIEWER, lat: 38.7, lng: -9.1, updated_at: new Date(NOW - MIN).toISOString() },
    ],
    location_preferences: [],
    plan_checkins: [],
    safe_return_sessions: [],
    trip_crew_location_sessions: [share],
    trip_subgroup_members: [],
  };
}

beforeEach(() => { invalidateTripOperationalProjectionsGate(); });

// ── 1. The CHECK is the registry ─────────────────────────────────────────────
describe("3753's CHECK is lib/locationPurposes.ts's id list", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  it("the CHECK enumerates exactly the registry ids", () => {
    const m = sql.match(/ADD CONSTRAINT trip_crew_location_sessions_purpose_check CHECK \(\s*purpose IS NULL OR purpose = ANY \(ARRAY\[([\s\S]*?)\]::text\[\]\)/);
    assert.ok(m, "the purpose CHECK was not found in 3753");
    const ids = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    assert.deepEqual([...ids].sort(), [...LOCATION_PURPOSES.map((p) => p.id)].sort());
    assert.deepEqual([...SHARE_PURPOSE_CHECK_IDS].sort(), [...ids].sort());
  });
  it("the postcondition checks the same list", () => {
    const post = sql.slice(sql.indexOf("DO $post$"));
    for (const p of LOCATION_PURPOSES) assert.ok(post.includes(`'${p.id}'`), `postcondition omits ${p.id}`);
  });
  it("the column is nullable with NO default (no silent purposing of legacy or direct rows)", () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS purpose text NULL;/);
    assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /purpose text[^;]*DEFAULT/i);
    assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /UPDATE public\.trip_crew_location_sessions/i, "3753 must not backfill");
  });
  it("the writer's purpose is a registry purpose that declares the share table", () => {
    assert.ok(purposesDeclaringShareTable().includes(CREW_LIVE_SHARE_PURPOSE));
    assert.equal(LEGACY_SHARE_CREATOR_PURPOSE, CREW_LIVE_SHARE_PURPOSE,
      "legacy rows were all written by the crew live-share writer; LSP-1's default keeps them there");
  });
});

// ── 2. The pure rule ──────────────────────────────────────────────────────────
describe("shareAdmittedFor: a share is visible only to the purpose it was granted for", () => {
  it("a share for X is invisible to every reader serving Y ≠ X", () => {
    for (const x of SHARE_PURPOSE_CHECK_IDS) for (const y of SHARE_PURPOSE_CHECK_IDS) {
      assert.equal(shareAdmittedFor(x, y), x === y, `${x} → reader ${y}`);
    }
  });
  it("a NULL / missing purpose (legacy) is visible to the crew live-share readers only", () => {
    for (const y of SHARE_PURPOSE_CHECK_IDS) {
      assert.equal(shareAdmittedFor(null, y), y === CREW_LIVE_SHARE_PURPOSE, `NULL → ${y}`);
      assert.equal(shareAdmittedFor(undefined, y), y === CREW_LIVE_SHARE_PURPOSE, `undefined → ${y}`);
    }
  });
  it("an unknown stored purpose, a non-string, or an unknown reader purpose admits nothing", () => {
    assert.equal(shareAdmittedFor("meetup", "meetup"), false);
    assert.equal(shareAdmittedFor("meetup", CREW_LIVE_SHARE_PURPOSE), false);
    assert.equal(shareAdmittedFor(42 as any, CREW_LIVE_SHARE_PURPOSE), false);
    assert.equal(shareAdmittedFor(CREW_LIVE_SHARE_PURPOSE, "nearby_discovery"), false);
    assert.equal(shareAdmittedFor(null, "nearby_discovery"), false);
  });
});

// ── 3. admitSharesForPurpose against a database ──────────────────────────────
describe("admitSharesForPurpose", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const store = () => ({ trip_crew_location_sessions: [
    { id: "a", purpose: CREW_LIVE_SHARE_PURPOSE }, { id: "b", purpose: OTHER }, { id: "c", purpose: null },
    // "d" is absent: deleted between the two reads
  ] });
  it("crew reader: own purpose + legacy; never the other purpose; never a row whose purpose was not established", async () => {
    const got = await admitSharesForPurpose(fake(store()), rows, CREW_LIVE_SHARE_PURPOSE);
    assert.deepEqual(got.map((r) => r.id), ["a", "c"]);
  });
  it("a reader serving another purpose sees only that purpose — never a crew grant, never a legacy row", async () => {
    const got = await admitSharesForPurpose(fake(store()), rows, OTHER);
    assert.deepEqual(got.map((r) => r.id), ["b"]);
  });
  it("column absent (3753 unapplied): every row is legacy — crew reader keeps all, any other reader none", async () => {
    const crewGot = await admitSharesForPurpose(fake(store(), { purposeColumn: "absent" }), rows, CREW_LIVE_SHARE_PURPOSE);
    assert.deepEqual(crewGot.map((r) => r.id), ["a", "b", "c", "d"]);
    const otherGot = await admitSharesForPurpose(fake(store(), { purposeColumn: "absent" }), rows, OTHER);
    assert.deepEqual(otherGot, []);
  });
  it("any other read failure THROWS — never 'no shares', never 'all shares'", async () => {
    await assert.rejects(admitSharesForPurpose(fake(store(), { purposeColumn: "error" }), rows, CREW_LIVE_SHARE_PURPOSE), SharePurposeUnreadableError);
    const noErrorField: any = { from: () => ({ select: () => ({ in: async () => ({ data: [] }) }) }) };
    await assert.rejects(admitSharesForPurpose(noErrorField, rows, CREW_LIVE_SHARE_PURPOSE), SharePurposeUnreadableError);
    const throws: any = { from: () => ({ select: () => ({ in: async () => { throw new Error("fetch failed"); } }) }) };
    await assert.rejects(admitSharesForPurpose(throws, rows, CREW_LIVE_SHARE_PURPOSE), SharePurposeUnreadableError);
    const otherColumnMissing: any = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { code: "42703", message: "column trip_crew_location_sessions.id does not exist" } }) }) }) };
    await assert.rejects(admitSharesForPurpose(otherColumnMissing, rows, CREW_LIVE_SHARE_PURPOSE), SharePurposeUnreadableError,
      "only a missing PURPOSE column means 'pre-3753'");
  });
  it("an unknown reader purpose gets nothing, without a query", async () => {
    const db = fake(store());
    assert.deepEqual(await admitSharesForPurpose(db, rows, "nearby_discovery"), []);
    assert.equal(db._selects.length, 0);
  });
});

// ── 4. The writer records the purpose ────────────────────────────────────────
describe("startLiveShare records the purpose it grants for", () => {
  it("the inserted row carries purpose = live_session_sharing", async () => {
    const db = fake({ trip_crew_location_sessions: [], trip_crew_location_events: [] });
    const r = await startLiveShare(db, { tripId: TRIP_ID, userId: SHARER, duration: "15m", allowedMemberIds: [VIEWER] });
    assert.equal(r.ok, true);
    const ins = db._inserts.filter((i: any) => i.table === "trip_crew_location_sessions");
    assert.equal(ins.length, 1);
    assert.equal(ins[0].row.purpose, CREW_LIVE_SHARE_PURPOSE);
  });
  it("on a database without the column it writes the pre-3753 row (a legacy row) instead of refusing", async () => {
    const db = fake({ trip_crew_location_sessions: [], trip_crew_location_events: [] }, { purposeColumn: "absent" });
    const r = await startLiveShare(db, { tripId: TRIP_ID, userId: SHARER, duration: "15m", allowedMemberIds: [VIEWER] });
    assert.equal(r.ok, true);
    const ins = db._inserts.filter((i: any) => i.table === "trip_crew_location_sessions");
    assert.equal(ins.length, 1);
    assert.equal("purpose" in ins[0].row, false);
  });
  it("any other insert failure is NOT retried without the purpose", async () => {
    const db = fake({ trip_crew_location_sessions: [], trip_crew_location_events: [] }, { purposeColumn: "error" });
    const r = await startLiveShare(db, { tripId: TRIP_ID, userId: SHARER, duration: "15m", allowedMemberIds: [VIEWER] });
    assert.equal(r.ok, false);
    assert.equal(db._inserts.filter((i: any) => i.table === "trip_crew_location_sessions").length, 0);
  });
});

// ── 5. Each reader refuses another purpose's grant ───────────────────────────
describe("getCrewMap: only a crew live-share grant discloses the sharer", () => {
  it("a crew-purpose grant discloses (control)", async () => {
    const map = await getCrewMap(fake(crew(CREW_LIVE_SHARE_PURPOSE)), TRIP_ID, VIEWER, NOW);
    const s = map.members.find((m) => m.userId === SHARER)!;
    assert.equal(s.liveShareActive, true);
    assert.ok(s.exactCoords);
  });
  it("a grant made for ANOTHER purpose is not a crew-map grant: no live share, no coordinates", async () => {
    const map = await getCrewMap(fake(crew(OTHER)), TRIP_ID, VIEWER, NOW);
    const s = map.members.find((m) => m.userId === SHARER)!;
    assert.equal(s.liveShareActive, false, "a presence_in_context grant was reused as a crew live share");
    assert.equal(s.exactCoords ?? null, null);
  });
  it("an unknown purpose discloses nothing", async () => {
    const map = await getCrewMap(fake(crew("meetup")), TRIP_ID, VIEWER, NOW);
    assert.equal(map.members.find((m) => m.userId === SHARER)!.liveShareActive, false);
  });
  it("a legacy NULL row keeps the crew-map visibility it was granted (LSP-1), with or without the column", async () => {
    for (const opts of [{}, { purposeColumn: "absent" as const }]) {
      const map = await getCrewMap(fake(crew(null), opts), TRIP_ID, VIEWER, NOW);
      assert.equal(map.members.find((m) => m.userId === SHARER)!.liveShareActive, true);
    }
  });
  it("an unreadable purpose is the crew map's 503, not an empty share list", async () => {
    await assert.rejects(getCrewMap(fake(crew(CREW_LIVE_SHARE_PURPOSE), { purposeColumn: "error" }), TRIP_ID, VIEWER, NOW), CrewMapUnavailableError);
  });
});

describe("getActiveLiveShares lists crew live shares only", () => {
  const store = () => ({ trip_crew_location_sessions: [
    { id: "a", trip_id: TRIP_ID, user_id: SHARER, status: "active", expires_at: "2999-01-01T00:00:00.000Z", started_at: "2026-01-01T00:00:00.000Z", allowed_member_ids: [VIEWER], visibility_level: "nearby", purpose: CREW_LIVE_SHARE_PURPOSE },
    { id: "b", trip_id: TRIP_ID, user_id: OWNER_ID, status: "active", expires_at: "2999-01-01T00:00:00.000Z", started_at: "2026-01-01T00:00:00.000Z", allowed_member_ids: [VIEWER], visibility_level: "nearby", purpose: OTHER },
    { id: "c", trip_id: TRIP_ID, user_id: OWNER_ID, status: "active", expires_at: "2999-01-01T00:00:00.000Z", started_at: "2026-01-01T00:00:00.000Z", allowed_member_ids: [VIEWER], visibility_level: "city_only", purpose: null },
  ] });
  it("crew + legacy, never the other purpose", async () => {
    const got = await getActiveLiveShares(fake(store()), TRIP_ID, VIEWER);
    assert.deepEqual(got.map((s) => s.sessionId).sort(), ["a", "c"]);
  });
  it("unreadable purpose → CrewMapUnavailableError", async () => {
    await assert.rejects(getActiveLiveShares(fake(store(), { purposeColumn: "error" }), TRIP_ID, VIEWER), CrewMapUnavailableError);
  });
});

describe("getViewerOwnPresence: liveShareActive means the viewer's own CREW live share", () => {
  const own = (purpose: string | null) => ({
    user_location_state: [{ user_id: VIEWER, lat: 1, lng: 2 }],
    trip_crew_location_sessions: [{ id: "o-1", trip_id: TRIP_ID, user_id: VIEWER, status: "active", expires_at: new Date(NOW + MIN).toISOString(), purpose }],
  });
  it("crew → true; other purpose → false; legacy → true", async () => {
    assert.equal((await getViewerOwnPresence(fake(own(CREW_LIVE_SHARE_PURPOSE)), TRIP_ID, VIEWER, NOW)).liveShareActive, true);
    assert.equal((await getViewerOwnPresence(fake(own(OTHER)), TRIP_ID, VIEWER, NOW)).liveShareActive, false);
    assert.equal((await getViewerOwnPresence(fake(own(null)), TRIP_ID, VIEWER, NOW)).liveShareActive, true);
  });
  it("another purpose's active row read FIRST cannot hide the viewer's own crew share (no limit before the filter)", async () => {
    const t = own(CREW_LIVE_SHARE_PURPOSE);
    t.trip_crew_location_sessions.unshift({ id: "o-0", trip_id: TRIP_ID, user_id: VIEWER, status: "active", expires_at: new Date(NOW + MIN).toISOString(), purpose: OTHER });
    assert.equal((await getViewerOwnPresence(fake(t), TRIP_ID, VIEWER, NOW)).liveShareActive, true);
  });
});

// ── 6. Every file that touches the store is declared; Nearby never touches it ─
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "test" && name !== "__tests__" && name !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const FROM_TABLE = /\.from\(\s*["'`]trip_crew_location_sessions["'`]\s*\)/;

describe("every source file that reads or writes the share store declares its purpose", () => {
  const touching = walk(SRC).filter((f) => FROM_TABLE.test(readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f).split(path.sep).join("/"));
  const declared = new Set(LOCATION_SHARE_ACCESS.map((e) => e.file));
  it("the scan finds the store's known users (it is not vacuous)", () => {
    assert.ok(touching.length >= 6, `only ${touching.length} files found`);
  });
  it("no undeclared file names the store", () => {
    const undeclared = touching.filter((f) => !declared.has(f));
    assert.deepEqual(undeclared, [], "declare these in LOCATION_SHARE_ACCESS with the purpose they serve");
  });
  it("every declared entry is real, and every reader/writer names a registry purpose", () => {
    for (const e of LOCATION_SHARE_ACCESS) {
      assert.ok(existsSync(path.join(SRC, e.file)), `${e.file} does not exist`);
      assert.ok(touching.includes(e.file), `${e.file} is declared but does not name the store`);
      if (e.kind === "reader" || e.kind === "writer") assert.ok(SHARE_PURPOSE_CHECK_IDS.includes(e.purpose!), `${e.file}: ${e.purpose}`);
      else assert.equal(e.purpose, null);
    }
  });
  it("every reader file actually filters through admitSharesForPurpose", () => {
    for (const e of LOCATION_SHARE_ACCESS.filter((x) => x.kind === "reader" || x.kind === "writer")) {
      assert.match(readFileSync(path.join(SRC, e.file), "utf8"), /admitSharesForPurpose\(/, `${e.file} reads shares without the purpose gate`);
    }
  });
  it("Nearby never names the share store (a crew grant cannot be reused for discovery)", () => {
    for (const f of SHARE_STORE_FORBIDDEN_READERS) {
      const text = readFileSync(path.join(SRC, f.file), "utf8");
      assert.doesNotMatch(text, /trip_crew_location_sessions/, `${f.file} names the share store`);
    }
  });
});
