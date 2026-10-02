/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW16): the NOW gateway's buddies layer keeps every buddy
 * inside its radius — at the radius's edge, across the 180th meridian and near a pole — before it is named whole.
 *
 * Round 19 (SW13) moved four near reads onto lib/nearBox; readBuddyMapPins kept its own box: `lat ± r/111.32` and
 * `lng ± r/(111.32·max(0.2, cos lat))`. 111.32 km per degree is a smaller degree than the 6371 km sphere haversineKm
 * measures on, so the box was narrower than the circle everywhere; it did not wrap at the line; and the 0.2 clamp made it
 * narrower still above ~78.5°. A buddy inside the radius was dropped by the query, and the layer was still named in
 * `sources` as whole. The box is now lib/nearBox's (`nearBox` + `applyNearBox`).
 *
 *   BM1  a buddy 49.97 km due north, radius 50 → a pin (the box is no narrower than the radius)
 *   BM2  a viewer at lng -179.98, a buddy ~10 km west across the line (lng 179.92) → a pin
 *   BM3  80°N, a buddy 45 km east (inside a 50 km radius) → a pin
 *   BM0  CONTROL: a buddy 20 km east at 38.7°N → a pin
 *   BM0b CONTROL: a buddy 50.05 km due north, radius 50 → no pin
 *   BM4  the box is in the query, ahead of the scan cap: 600 buddies 3000 km away, ranked first, and one 5 km away
 *        → the near buddy is a pin and the layer is not capped (without the box the cap is filled by the far ones)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readBuddyMapPins } from "../lib/buddyMapRead.js";

interface Row { [k: string]: unknown }
type Pred = (r: Row) => boolean;
function term(t: string): Pred {
  const nested = /^(and|or)\((.*)\)$/.exec(t);
  if (nested) { const parts = splitTop(nested[2]!).map(term); return nested[1] === "and" ? (r) => parts.every((p) => p(r)) : (r) => parts.some((p) => p(r)); }
  const m = /^([a-z_]+)\.(gte|lte|gt|lt|eq)\.(.*)$/.exec(t);
  if (!m) throw new Error(`unsupported or-term: ${t}`);
  const [, c, op, raw] = m; const v = Number(raw);
  return (r) => { const x = r[c!] as number; if (x == null) return false; return op === "gte" ? x >= v : op === "lte" ? x <= v : op === "gt" ? x > v : op === "lt" ? x < v : x === v; };
}
function splitTop(s: string): string[] { const out: string[] = []; let d = 0; let cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur); cur = ""; } else cur += ch; } if (cur) out.push(cur); return out; }

function client(buddies: Row[]) {
  const tables: Record<string, Row[]> = { feature_flags: [{ flag: "rent_buddy_enabled", enabled: true }], rent_buddy_profiles: buddies };
  return {
    from(name: string) {
      let rows = [...(tables[name] ?? [])]; let limit: number | null = null;
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
        not: (c: string, op: string, v: unknown) => { if (op === "is" && v === null) rows = rows.filter((r) => r[c] != null); return q; },
        gte: (c: string, v: number) => { rows = rows.filter((r) => r[c] != null && (r[c] as number) >= v); return q; },
        lte: (c: string, v: number) => { rows = rows.filter((r) => r[c] != null && (r[c] as number) <= v); return q; },
        or: (expr: string) => { rows = rows.filter(term(`or(${expr})`)); return q; },
        order: () => q, limit: (n: number) => { limit = n; return q; },
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: limit === null ? rows : rows.slice(0, limit), error: null }).then(res, rej),
      };
      return q;
    },
  };
}
const KM_PER_DEG = (6371 * Math.PI) / 180;
const buddy = (i: number, lat: number, lng: number): Row => ({
  id: `b${i}`, user_id: `u${i}`, display_name: `Buddy ${i}`, status: "active", admin_status: "active", city: "X", country: "XX",
  meetup_base_lat: lat, meetup_base_lng: lng, review_count: 1,
});
async function read(viewer: { lat: number; lng: number }, bs: Row[], radiusKm = 50) {
  const r = await readBuddyMapPins(client(bs) as never, "viewer", { lat: viewer.lat, lng: viewer.lng, radiusKm, blockedSet: new Set() });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return r;
}
async function pins(viewer: { lat: number; lng: number }, b: Row, radiusKm = 50) {
  const r = await read(viewer, [b], radiusKm);
  return r.ok ? r.pins.length : -1;
}

describe("census-discovery §117 (SW16): the buddies layer keeps every buddy inside its radius", () => {
  it("BM0 CONTROL: a buddy 20 km east at 38.7°N → a pin", async () => {
    assert.equal(await pins({ lat: 38.7, lng: -9.1 }, buddy(1, 38.7, -9.1 + 20 / (KM_PER_DEG * Math.cos((38.7 * Math.PI) / 180)))), 1);
  });
  it("BM0b CONTROL: a buddy 50.05 km due north, radius 50 → no pin", async () => {
    assert.equal(await pins({ lat: 38.7, lng: -9.1 }, buddy(1, 38.7 + 50.05 / KM_PER_DEG, -9.1)), 0);
  });
  it("BM1 a buddy 49.97 km due north, radius 50 → a pin", async () => {
    assert.equal(await pins({ lat: 38.7, lng: -9.1 }, buddy(1, 38.7 + 49.97 / KM_PER_DEG, -9.1)), 1);
  });
  it("BM2 a viewer at lng -179.98, a buddy ~10 km west across the line → a pin", async () => {
    assert.equal(await pins({ lat: -16.82, lng: -179.98 }, buddy(1, -16.82, 179.92)), 1);
  });
  it("BM3 80°N, a buddy 45 km east (inside a 50 km radius) → a pin", async () => {
    assert.equal(await pins({ lat: 80, lng: 10 }, buddy(1, 80, 10 + 45 / (KM_PER_DEG * Math.cos((80 * Math.PI) / 180)))), 1);
  });
  it("BM4 600 buddies 3000 km away ranked first and one 5 km away → the near one is a pin, not capped", async () => {
    const far = Array.from({ length: 600 }, (_, i) => ({ ...buddy(100 + i, 38.7 + 3000 / KM_PER_DEG, -9.1), review_count: 1000 }));
    const r = await read({ lat: 38.7, lng: -9.1 }, [...far, buddy(1, 38.7 + 5 / KM_PER_DEG, -9.1)]);
    assert.ok(r.ok);
    assert.deepEqual(r.pins.map((p: any) => p.id), ["b1"]);
    assert.equal((r as { capped?: boolean }).capped, undefined);
  });
});
