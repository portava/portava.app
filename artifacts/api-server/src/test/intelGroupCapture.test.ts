/**
 * Capture → group_key integration (the leak-closing composition). Proves that
 * writeObservation resolves the independent-group identity end-to-end through the
 * real hierarchy: a client-supplied validated crew wins; else a SERVER-RESOLVED
 * active crew wins and OVERRIDES a "just me" answer (this is what stops a crew
 * member from splitting the crew into solo groups); else "just me" is a per-actor
 * solo group; else null. The stored group_key is checked against deriveGroupKey so
 * the whole path — not just the pieces — is verified.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeObservation } from "../services/intel/IntelCaptureService.js";
import { deriveGroupKey } from "../lib/intelGroupKey.js";

const ACTOR = "11111111-1111-1111-1111-111111111111";
const PLACE = "22222222-2222-2222-2222-222222222222";
// writeObservation resolves the active crew against the REAL clock (new Date()),
// so the window is computed around today to keep this test date-stable.
function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const ACTIVE = { start_date: isoDay(-1), end_date: isoDay(1) };

/**
 * A fake covering every table writeObservation touches for a quick_signal capture:
 * feature_flags (on), places (subject exists), trips + trip_members (crew
 * resolution), intel_observations (insert-select). Config picks the crew shape.
 */
function makeDb(cfg: { trips?: any[]; members?: any[] }) {
  const inserted: any[] = [];
  function from(table: string) {
    let op: "select" | "insert" = "select";
    let payload: any = null;
    const eqs: [string, any][] = [];
    let inF: [string, any[]] | null = null;
    let lteF: [string, string] | null = null;
    let gteF: [string, string] | null = null;
    let lim = Infinity, orderCol: string | null = null, orderAsc = true;
    const src = (): any[] => (table === "trips" ? cfg.trips ?? [] : table === "trip_members" ? cfg.members ?? [] : []);
    function rows() {
      let r = src().filter(
        (row: any) =>
          eqs.every(([c, v]) => row[c] === v) &&
          (!inF || inF[1].includes(row[inF[0]])) &&
          (!lteF || (row[lteF[0]] != null && row[lteF[0]] <= lteF[1])) &&
          (!gteF || (row[gteF[0]] != null && row[gteF[0]] >= gteF[1])),
      );
      if (orderCol) { const c = orderCol; r = [...r].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (orderAsc ? 1 : -1)); }
      return r.slice(0, lim);
    }
    function run() {
      if (table === "feature_flags") return { data: { enabled: true }, error: null };
      if (table === "places") return { data: { id: PLACE }, error: null };
      if (op === "insert") { const row = { id: "obs-1", schema_version: 1, ...payload }; inserted.push(row); return { data: row, error: null }; }
      return { data: rows()[0] ?? null, error: null };
    }
    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { inF = [c, v]; return b; },
      lte(c: string, v: string) { lteF = [c, v]; return b; },
      gte(c: string, v: string) { gteF = [c, v]; return b; },
      order(c: string, o: { ascending: boolean }) { orderCol = c; orderAsc = o.ascending; return b; },
      limit(_n: number) { lim = _n; return Promise.resolve({ data: rows(), error: null }); },
      maybeSingle() { return Promise.resolve(run()); },
      single() { return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(op === "insert" ? run() : { data: rows(), error: null }).then(res); },
    };
    return b;
  }
  return { from, _inserted: inserted };
}

const input = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE, claimType: "crowd.level", value: { level: "busy" },
  // ~1h ago relative to the real clock, so clampObservedAt never rejects it as future.
  observedAt: new Date(Date.now() - 3_600_000).toISOString(), idempotencyKey: "k-1", ...over,
});

describe("capture → group_key integration (server-crew override closes the leak)", () => {
  const prev = process.env.SESSION_SECRET;
  before(() => { process.env.SESSION_SECRET = "test-session-secret-please-ignore-0123456789"; });
  after(() => { if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev; });

  it("'just me' + a server-resolved active OWNED crew → crew key (overrides solo)", async () => {
    const db = makeDb({ trips: [{ id: "trip-A", owner_id: ACTOR, ...ACTIVE }] });
    const r = await writeObservation(db as any, ACTOR, input({ partySize: "just_me" }) as any);
    assert.equal(r.ok, true);
    const stored = db._inserted[0];
    assert.equal(stored.group_key, deriveGroupKey(PLACE, { kind: "crew", crewId: "trip-A" }), "crew, not solo");
    assert.notEqual(stored.group_key, deriveGroupKey(PLACE, { kind: "solo", actorId: ACTOR }));
    assert.equal(stored.party_size_bucket, "just_me");
  });

  it("'just me' + NO active crew → per-actor solo key", async () => {
    const db = makeDb({ trips: [], members: [] });
    const r = await writeObservation(db as any, ACTOR, input({ partySize: "just_me" }) as any);
    assert.equal((r as any).observation ? true : r.ok, true);
    assert.equal(db._inserted[0].group_key, deriveGroupKey(PLACE, { kind: "solo", actorId: ACTOR }));
  });

  it("no attestation, no crew → null group_key (zero group credit)", async () => {
    const db = makeDb({ trips: [], members: [] });
    await writeObservation(db as any, ACTOR, input() as any);
    assert.equal(db._inserted[0].group_key, null);
  });

  it("a client-supplied validated crew id is honoured (member of the trip)", async () => {
    const db = makeDb({ trips: [{ id: "trip-B", owner_id: "someone" }], members: [{ trip_id: "trip-B", user_id: ACTOR, role: "member" }] });
    await writeObservation(db as any, ACTOR, input({ partyId: "trip-B", partySize: "just_me" }) as any);
    assert.equal(db._inserted[0].group_key, deriveGroupKey(PLACE, { kind: "crew", crewId: "trip-B" }));
  });
});
