/**
 * census-media §36 (MD101) — §15 "Find Similar / Cheaper / Quieter / Busier":
 * the Busier half, behind `media_find_busier_enabled` (migration 3351, seeded OFF).
 *
 * WHAT IS PROVED, AND THE LINE EACH CASE TURNS RED ON
 *   A. `busier` is a comparator axis grounded on the SAME claim type as
 *      `quieter` (COMPARATOR_AXIS_CLAIM.busier), and grounds only on it.
 *   B. With the flag OFF the §32 context reports exactly §32's two axes, as it
 *      did before (buildComparatorBaselines' default; comparatorAxesFor).
 *   C. With the flag ON the rail offers find_busier directly after Find Cheaper,
 *      under Find Quieter's own conditions — Compass on AND a place the choke
 *      point lets the viewer be told about (withFindBusierAction). A post whose
 *      owner hid the place gets no Busier row: a non-owner learns nothing more.
 *   D. The Compass context built for the same media carries the busier axis
 *      only with the flag on, and the prompt names it.
 *   E. Migration 3351 seeds the flag FALSE.
 *
 * Run: node --import tsx/esm --test src/test/mediaFindBusier.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPARATOR_AXIS_CLAIM,
  SECTION32_COMPARATOR_AXES,
  WITH_BUSIER_COMPARATOR_AXES,
  buildComparatorBaselines,
  buildCompassMediaContext,
  comparatorAxesFor,
  formatMediaContextLines,
} from "../compass/CompassMediaContext.js";
import { resolveViewer } from "../services/media/MediaProjectionService.js";
import { FIND_BUSIER_FLAG, resolveMediaActions, withFindBusierAction } from "../services/media/MediaActionResolver.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW_MS = Date.parse("2026-09-27T20:00:00.000Z");

type Dataset = Record<string, any[]>;

function makeSc(data: Dataset) {
  const resolveRows = (table: string, filters: Array<(r: any) => boolean>) =>
    (data[table] ?? []).map((r) => ({ ...r })).filter((r) => filters.every((f) => f(r)));
  const builder = (table: string): any => {
    const filters: Array<(r: any) => boolean> = [];
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push((r) => String(r[col]) === String(val)); return b; },
      neq(col: string, val: any) { filters.push((r) => String(r[col]) !== String(val)); return b; },
      in(col: string, val: any[]) { const v = val.map(String); filters.push((r) => v.includes(String(r[col]))); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] > val); return b; },
      gte() { return b; }, lte() { return b; },
      is(col: string, val: any) { filters.push((r) => (r[col] ?? null) === val); return b; },
      ilike() { return b; }, like() { return b; }, not() { return b; }, or() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: resolveRows(table, filters), error: null }).then(onF, onR); },
    };
    return b;
  };
  return {
    from(table: string) { return builder(table); },
    rpc() { return Promise.resolve({ data: null, error: { message: "no rpc in this fake" } }); },
  } as any;
}

const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR = "22222222-2222-2222-2222-222222222222";
const PLACE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MEDIA = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function makePost(o: Record<string, any> = {}): any {
  return {
    id: MEDIA, author_id: AUTHOR, trip_id: null, content: "", visibility: "public", status: "active",
    post_status: "published", moderation_status: null, publish_at: null, expires_at: null, deleted_at: null,
    updated_at: new Date().toISOString(), created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    category: "nightlife", media_urls: [], location_name: "An Thuong Bar", location_city: "Da Nang",
    location_country: "Vietnam", location_privacy_mode: o.location_privacy_mode ?? "none",
    canonical_place_id: o.canonical_place_id === undefined ? PLACE : o.canonical_place_id,
    post_media: [{ id: "m1", media_type: "image", public_url: "https://cdn.example/m.jpg", thumbnail_url: null, duration_seconds: null, width: 1080, height: 1080, sort_order: 0, processing_status: "ready", moderation_status: null }],
    profiles: { id: AUTHOR, username: "maya", full_name: "Maya", name: "Maya", display_name: "Maya", avatar_url: null, verified: true, is_official: false, account_status: "active", is_private: false },
  };
}

function data(opts: { compass: boolean; busier: boolean; post?: any }): Dataset {
  const flags: any[] = [];
  if (opts.compass) flags.push({ flag: "COMPASS_ENABLED", enabled: true });
  if (opts.busier) flags.push({ flag: FIND_BUSIER_FLAG, enabled: true });
  return {
    posts: [opts.post ?? makePost()],
    profiles: [
      { id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" },
      { id: AUTHOR, account_status: "active", passport_visibility: "public", is_private: false },
    ],
    blocks: [], user_mutes: [], user_follows: [], trip_members: [], trips: [], hidden_gems: [],
    feature_flags: flags, intel_state_snapshots: [], intel_live_promoted_scopes: [],
  };
}

async function rail(d: Dataset) {
  const sc = makeSc(d);
  const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
  return resolveMediaActions(sc, viewer, MEDIA, Date.now());
}

const claim = (claimType: string) => ({ claimType, band: "moderate", sourceClass: "community", observedAt: new Date(NOW_MS - 60_000).toISOString(), validUntil: new Date(NOW_MS + 3_600_000).toISOString() });

beforeEach(() => { invalidateFlagsCache(); _clearPromotedScopeCache(); });

describe("A. busier is the other direction of the crowd reading", () => {
  it("is grounded on crowd.level — the claim type quieter compares on", () => {
    assert.equal(COMPARATOR_AXIS_CLAIM.busier, "crowd.level");
    assert.equal(COMPARATOR_AXIS_CLAIM.busier, COMPARATOR_AXIS_CLAIM.quieter);
  });
  it("a crowd reading grounds busier; a price reading does not", () => {
    const withCrowd = buildComparatorBaselines([claim("crowd.level")], NOW_MS, WITH_BUSIER_COMPARATOR_AXES);
    assert.equal(withCrowd.find((a) => a.axis === "busier")!.grounded, true);
    const withPrice = buildComparatorBaselines([claim("price.cover")], NOW_MS, WITH_BUSIER_COMPARATOR_AXES);
    assert.equal(withPrice.find((a) => a.axis === "busier")!.grounded, false);
  });
  it("carries provenance, never a value", () => {
    const b = buildComparatorBaselines([claim("crowd.level")], NOW_MS, WITH_BUSIER_COMPARATOR_AXES).find((a) => a.axis === "busier")!;
    assert.deepEqual(Object.keys(b).sort(), ["axis", "band", "claimType", "conflictState", "grounded", "observedAt", "sourceClass"]);
  });
});

describe("B. flag OFF: §32's two axes, exactly as before", () => {
  it("the default is quieter and cheaper, in that order", () => {
    assert.deepEqual(buildComparatorBaselines([], NOW_MS).map((a) => a.axis), ["quieter", "cheaper"]);
    assert.deepEqual([...SECTION32_COMPARATOR_AXES], ["quieter", "cheaper"]);
  });
  it("comparatorAxesFor answers by the flag, and a failed read is OFF", async () => {
    assert.deepEqual([...(await comparatorAxesFor(makeSc(data({ compass: true, busier: false }))))], ["quieter", "cheaper"]);
    assert.deepEqual([...(await comparatorAxesFor(makeSc(data({ compass: true, busier: true }))))], ["quieter", "cheaper", "busier"]);
    const throwing = { from() { throw new Error("down"); } } as any;
    assert.deepEqual([...(await comparatorAxesFor(throwing))], ["quieter", "cheaper"]);
  });
});

describe("C. the rail offers Find Busier only with the flag, Compass, and a disclosable place", () => {
  it("flag OFF: no find_busier (Quieter and Cheaper as before)", async () => {
    const set = await rail(data({ compass: true, busier: false }));
    const ids = set!.actions.map((a) => a.id);
    assert.ok(ids.includes("find_quieter") && ids.includes("find_cheaper"));
    assert.equal(ids.includes("find_busier" as any), false);
  });
  it("flag ON: find_busier sits directly after Find Cheaper and asks Compass with its own comparator", async () => {
    const set = await rail(data({ compass: true, busier: true }));
    const ids = set!.actions.map((a) => a.id);
    assert.equal(ids.indexOf("find_busier" as any), ids.indexOf("find_cheaper") + 1);
    const b = set!.actions.find((a) => a.id === "find_busier")!;
    assert.equal(b.outcome, "compass");
    assert.equal(b.target.method, "POST");
    assert.equal(b.target.endpoint, "/api/compass/ask");
    assert.equal(b.target.params?.comparator, "busier");
    assert.equal(b.target.params?.mediaId, MEDIA);
    assert.equal(b.target.params?.prompt, "Find a busier version of this.");
  });
  it("flag ON: it is inserted after Find Cheaper even when other actions follow, and the rest keep their order", async () => {
    const mk = (id: string) => ({ id, label: id, outcome: "compass", target: { method: "GET", endpoint: "/x" } }) as any;
    const sc = makeSc(data({ compass: true, busier: true }));
    const out = await withFindBusierAction(sc, { mediaId: MEDIA, placeId: PLACE } as any, [mk("find_quieter"), mk("find_cheaper"), mk("view_passport"), mk("report")], true);
    assert.deepEqual(out.map((a) => a.id), ["find_quieter", "find_cheaper", "find_busier", "view_passport", "report"]);
    const input = [mk("find_quieter")];
    const untouched = await withFindBusierAction(makeSc(data({ compass: true, busier: false })), { mediaId: MEDIA, placeId: PLACE } as any, input, true);
    assert.equal(untouched, input, "flag off: the very same array comes back");
  });

  it("flag ON, Compass OFF: no find_busier", async () => {
    const set = await rail(data({ compass: false, busier: true }));
    assert.equal(set!.actions.some((a) => a.id === ("find_busier" as any)), false);
  });
  it("flag ON, the owner hid the place (city_only): no find_busier — there is no anchor to be busier than", async () => {
    const set = await rail(data({ compass: true, busier: true, post: makePost({ location_privacy_mode: "city_only" }) }));
    assert.equal(set!.actions.some((a) => a.id === ("find_busier" as any)), false);
    assert.equal(set!.actions.some((a) => a.id === "find_quieter"), false, "…the same rule Quieter already follows");
  });
});

describe("D. the Compass media context carries busier only with the flag", () => {
  it("flag OFF: two axes; flag ON: three, and the prompt names busier", async () => {
    for (const busier of [false, true]) {
      const sc = makeSc(data({ compass: true, busier }));
      const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
      const ctx = await buildCompassMediaContext(sc, viewer, MEDIA, NOW_MS);
      assert.ok(ctx, "the viewer may see the media");
      assert.deepEqual(ctx!.comparator.map((a) => a.axis), busier ? ["quieter", "cheaper", "busier"] : ["quieter", "cheaper"]);
      const lines = formatMediaContextLines(ctx!).join("\n");
      assert.equal(/busier/.test(lines), busier, `busier ${busier ? "is" : "is not"} named in the prompt`);
    }
  });
});

describe("E. migration 3351", () => {
  const sql = readFileSync(join(HERE, "..", "migrations", "3351_media_find_busier_flag.sql"), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  it("seeds the flag FALSE, refuses a seed that finds it ON, and touches nothing else", () => {
    assert.match(code, /'media_find_busier_enabled',\s*false,/);
    assert.match(code, /enabled = TRUE;\s*IF on_count <> 0 THEN\s*RAISE EXCEPTION/);
    assert.ok(!/\b(ALTER|CREATE|DROP)\s+(TABLE|TYPE|INDEX|POLICY|FUNCTION)\b/i.test(code));
    assert.equal(FIND_BUSIER_FLAG, "media_find_busier_enabled");
  });
});
