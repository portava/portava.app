/**
 * census-highlights-memories H4 (the reader half), on the Telegraph STAMP share
 * card — wave 5, lane 7. The last OPEN reader in stampReaderCallSites.test.ts.
 *
 * H4: "Planned/saved/nearby never represented as 'experienced' without
 * occurrence evidence or user confirmation." A share card hands a stamp to a
 * CONVERSATION — other people. services/passport/stampPresenceView.ts is the one
 * rule: a stamp's place is shown only for a presence stamp whose own source's
 * evidence (a GPS stamp-eligible postcard, a check-in on the trip) is read and
 * holds; and a presence stamp whose evidence does not hold is not handed to
 * anybody at all, because its very name ("City Explorer") claims the visit.
 *
 * WHAT WOULD TURN THIS RED
 *   - the card printing the stored [city, country] without the view (the old
 *     subtitle);
 *   - an unevidenced presence stamp resolving (its name claims an occurrence);
 *   - an UNREADABLE evidence table read as evidence, or as "no evidence" that
 *     still shows the card — it must be `unknown`, carrying nothing;
 *   - a non-presence stamp (an achievement) losing its card, or keeping a place.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphStampCardPresence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveShareProjections } from "../services/telegraph/shareables.js";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b2";   // the stamp's owner
const THREAD = "dddddddd-0000-4000-8000-0000000000d3";
const DEF = "eeeeeeee-0000-4000-8000-0000000000e4";
const S = (n: number) => `5a000000-0000-4000-8000-00000000000${n}`;

type Row = Record<string, any>;
const stamp = (id: string, over: Row) => ({ id, user_id: BOB, stamp_definition_id: DEF, title_override: null, city: "Hue", country: "VN", visibility: "public", display_on_passport: true, is_revoked: false, earned_at: "2026-04-01T00:00:00.000Z", ...over });

function world(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    user_stamps: [
      stamp(S(1), { source_type: "posts", source_id: "post-ok", stamp_definitions: { slug: "city_explorer" } }),       // evidenced presence
      stamp(S(2), { source_type: "posts", source_id: "post-unverified", stamp_definitions: { slug: "city_explorer" } }), // presence, postcard not stamp-eligible
      stamp(S(3), { source_type: "posts", source_id: "post-missing", stamp_definitions: [{ slug: "world_citizen" }] }),  // presence, no postcard at all
      stamp(S(4), { source_type: "trips", source_id: "trip-1", stamp_definitions: { slug: "trip_planner" } }),          // an achievement (planning), stored with the destination
      stamp(S(5), { source_type: "admin", source_id: null, stamp_definitions: { slug: "city_explorer" } }),             // a presence stamp an admin typed a place into: no source evidence exists
      stamp(S(6), { source_type: null, source_id: null }),                                                                // a legacy row with no definition slug
    ],
    stamp_definitions: [{ id: DEF, name: "City Explorer", icon_url: null, universal_artwork_url: null }],
    passport_postcards: [
      { user_id: BOB, post_id: "post-ok", stamp_eligible: true, stamp_revoked: false },
      { user_id: BOB, post_id: "post-unverified", stamp_eligible: false, stamp_revoked: false },
    ],
    blocks: [],
    ...extra,
  };
}

function client(db: Record<string, Row[]>, failReads: string[] = []) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let lim: number | null = null;
    const run = () => (failReads.includes(table)
      ? { data: null, error: { message: `${table} unreadable` } }
      : { data: (db[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim ?? undefined), error: null });
    const t: any = {
      select() { return p; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return p; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return p; },
      in(c: string, vs: any[]) { filters.push((r) => vs.map(String).includes(String(r[c]))); return p; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return p; },
      limit(k: number) { lim = k; return p; },
      maybeSingle() { const r = run(); return Promise.resolve(r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null }); },
      then(res: any, rej?: any) { return Promise.resolve(run()).then(res, rej); },
    };
    const p: any = new Proxy(t, { get(o, k) { if (k in o) return o[k as string]; if (k === "catch" || k === "finally") return undefined; return () => p; } });
    return p;
  }
  return { from, rpc: async () => ({ data: null, error: { code: "PGRST202" } }) } as any;
}

async function card(id: string, opts: { viewer?: string; db?: Record<string, Row[]>; failReads?: string[] } = {}) {
  const [r] = await resolveShareProjections(client(opts.db ?? world(), opts.failReads), opts.viewer ?? ALICE, THREAD, [{ objectType: "STAMP", objectId: id }]);
  return r!;
}

describe("H4 — the Telegraph STAMP card names a place only with presence evidence", () => {
  it("an evidenced presence stamp (GPS stamp-eligible postcard) resolves with its place", async () => {
    const r = await card(S(1));
    assert.equal(r.available, true, JSON.stringify(r));
    assert.equal(r.available === true && r.projection.title, "City Explorer");
    assert.equal(r.available === true && r.projection.subtitle, "Hue, VN");
  });

  for (const [n, why] of [[2, "its postcard was not stamp-eligible"], [3, "no postcard exists"], [5, "an admin source names no evidence"]] as const) {
    it(`a presence stamp whose evidence does not hold is not handed to the conversation (${why})`, async () => {
      const r = await card(S(n));
      assert.equal(r.available, false);
      assert.equal(r.available === false && r.reason, "not_found");
      assert.equal(r.projection, null);
      assert.ok(!JSON.stringify(r).includes("Hue"), "the place leaked");
    });
  }

  it("…not to its owner either: the card is shown to the whole conversation", async () => {
    const r = await card(S(2), { viewer: BOB });
    assert.equal(r.available === false && r.reason, "not_found");
  });

  it("an UNREADABLE evidence table is `unknown` and carries nothing — never read as evidence (fail closed)", async () => {
    const r = await card(S(1), { failReads: ["passport_postcards"] });
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown", "an outage is not 'not found' and is never 'evidenced'");
    assert.equal(r.projection, null);
    assert.ok(!JSON.stringify(r).includes("Hue"));
  });

  it("an achievement (a planning stamp) keeps its card but never its stored place", async () => {
    const r = await card(S(4));
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.projection.title, "City Explorer");
    assert.equal(r.available === true && r.projection.subtitle, null, "a planned destination shown as a visited place");
  });

  it("a legacy row with no definition slug reads as not-presence: card kept, place withheld", async () => {
    const r = await card(S(6));
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.projection.subtitle, null);
  });

  it("CONTROL: the old gates still come first — a revoked or private stamp degrades without any evidence read", async () => {
    const db = world({ user_stamps: [stamp(S(7), { is_revoked: true, source_type: "posts", source_id: "post-ok", stamp_definitions: { slug: "city_explorer" } }), stamp(S(8), { visibility: "private", source_type: "posts", source_id: "post-ok", stamp_definitions: { slug: "city_explorer" } })] });
    assert.equal(((await card(S(7), { db, failReads: ["passport_postcards"] })) as any).reason, "deleted");
    assert.equal(((await card(S(8), { db, failReads: ["passport_postcards"] })) as any).reason, "private");
  });
});
