/**
 * S97 / S111 — §18.3 entity reconciliation, and the nearest-place snap that
 * existed to satisfy a foreign key.
 *
 * THE TWO SENTENCES
 * =================
 *   §18.3  "Observed activity cluster -> Place? Event? Temporary world object?
 *           Unknown?  Never assign to the nearest place merely to satisfy a
 *           foreign key."
 *   §14    "Temporary activity must not be forced onto nearest place ID when
 *           ownership is unknown."
 *
 * They failed for one reason each, and it was the SAME reason:
 *
 *   S111  `intel_observations.subject_id` was `NOT NULL REFERENCES places(id)`,
 *         so two of the four outcomes — `unknown` and `temporary_world_object` —
 *         could not be STORED. lib/sensingSubjectReconciliation resolved them
 *         correctly and had nowhere to put the answer.
 *   S97   `routes/mapObservations.ts` resolved a §22 zone contribution to the
 *         NEAREST active place and stored the observation against it. Its own
 *         header gave the motive: "`intel_observations.subject_id` FKs
 *         `public.places`, and a zone is not a place."
 *
 * So they close together, and only together: migration 3002 makes `subject_id`
 * nullable (keeping the places FK for non-null subjects), which removes the
 * requirement the snap existed to satisfy, which is why the resolver could be
 * DELETED rather than bypassed.
 *
 * WHAT THIS FILE ASSERTS
 * ======================
 *   1. the proximity code is GONE from the route — by absence, scanned from the
 *      source, because "we stopped calling it" is not the same as "it is not
 *      there";
 *   2. the schema admits all four outcomes, and REFUSES the two shapes that
 *      would smuggle the snap back;
 *   3. the capture path stores an unowned zone contribution with no place id and
 *      reads `places` not even once while doing it;
 *   4. an OWNERSHIP signal (a registered venue zone) still resolves to a place —
 *      the rule is "proximity is not ownership", not "nothing is".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ingestMapContribution, resolveZoneSubject } from "../routes/mapObservations.js";
import { writeObservation, proposeClaim } from "../services/intel/IntelCaptureService.js";
import { reconcileSensingSubject, subjectStorageFor } from "../lib/sensingSubjectReconciliation.js";
import { CROWD_DIRECTIONS } from "../lib/intelContracts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");
const ROUTE_SRC = readFileSync(join(HERE, "../routes/mapObservations.ts"), "utf8");

/** The route source with its comments stripped — prose ABOUT the snap is not the snap. */
const ROUTE_CODE = ROUTE_SRC
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

function migrationsAfter(prefix: number): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => (Number(a.split("_")[0]) || 0) - (Number(b.split("_")[0]) || 0))
    .filter((f) => (Number(f.split("_")[0]) || 0) > prefix)
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), "utf8") }));
}

const flat = (s: string) => s.replace(/\s+/g, " ");

// ─────────────────────────────────────────────────────────────────────────────
// A. S97 — the proximity resolution is gone, not disabled
// ─────────────────────────────────────────────────────────────────────────────

describe("S97 — routes/mapObservations.ts contains no proximity resolution", () => {
  it("premise: the route still HAS a zone path (else this is vacuous)", () => {
    assert.match(ROUTE_CODE, /isZoneSubjectKind/, "the zone path was deleted wholesale — that is the other alternative, and it is not this one");
    assert.match(ROUTE_CODE, /resolveZoneSubject/, "no zone subject resolution at all");
  });

  it("no distance, no radius, no bounding box, no nearest", () => {
    const banned: Array<[RegExp, string]> = [
      [/haversine/i, "a great-circle distance"],
      [/KM_PER_DEGREE_LAT/, "the degree-to-km constant the bbox pre-filter used"],
      [/ZONE_ANCHOR/, "the anchor radius constants"],
      [/resolveZoneAnchorSubject/, "the nearest-place resolver itself"],
      [/zoneAnchorPoint/, "the zone centroid the search started from"],
      [/\bbestKm\b|\bradiusKm\b|\bradiusM\b/, "a radius comparison"],
      [/\blatitude\b|\blongitude\b/, "a coordinate read — a zone contribution needs none"],
    ];
    for (const [re, what] of banned) {
      assert.ok(
        !re.test(ROUTE_CODE),
        `${what} is still present in the route (${re}). §18.3's sentence carries no radius, so a smaller one is not a smaller violation.`,
      );
    }
  });

  it("the route uses the §18.3 resolver rather than restating its rule", () => {
    assert.match(
      ROUTE_CODE,
      /from "\.\.\/lib\/sensingSubjectReconciliation\.js"/,
      "the route resolves subjects without the module that owns the rule",
    );
    assert.match(ROUTE_CODE, /reconcileSensingSubject\(/, "the resolver is imported but not called");
  });

  it("the only ownership signal it looks for is a REGISTERED zone -> place mapping", () => {
    // venue_anchor and operator_assignment are ownership; proximity and
    // name_match are not, and the route must not reach for either.
    assert.match(ROUTE_CODE, /evidence: "venue_anchor"/, "no ownership signal is offered to the resolver at all");
    assert.ok(!/"proximity"/.test(ROUTE_CODE), "the route offers `proximity` as evidence — the resolver would refuse it, but offering it is the intent");
    assert.ok(!/"name_match"/.test(ROUTE_CODE), "the route offers `name_match` as evidence");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. S111 — all four outcomes are storable, and the two unowned ones are pinned
// ─────────────────────────────────────────────────────────────────────────────

describe("S111 — the schema admits §18.3's four outcomes", () => {
  const widener = () => {
    const m = migrationsAfter(2130).find((x) => /ALTER COLUMN subject_id DROP NOT NULL/.test(x.sql));
    assert.ok(m, "no migration makes intel_observations.subject_id nullable — `unknown` and `temporary_world_object` still cannot be stored");
    return m;
  };

  it("premise: 2130 really does declare subject_id NOT NULL REFERENCES places(id)", () => {
    const sql = readFileSync(join(MIGRATIONS, "2130_intel_storage.sql"), "utf8");
    assert.match(sql, /subject_id\s+uuid NOT NULL REFERENCES public\.places\(id\)/);
  });

  it("subject_id becomes nullable and the subject-kind vocabulary gains both unowned kinds", () => {
    const f = flat(widener().sql);
    for (const kind of ["temporary_world_object", "unknown"]) {
      assert.ok(
        new RegExp(`subject_kind IN \\([^)]*'${kind}'`).test(f),
        `the subject_kind CHECK still refuses '${kind}'`,
      );
    }
  });

  it("the places foreign key is KEPT — only the requirement went", () => {
    const f = flat(widener().sql);
    // The two shapes that would remove it: dropping the named constraint, or a
    // catalogue-driven drop keyed on the referenced table.
    assert.ok(
      !/DROP CONSTRAINT (IF EXISTS )?[a-z_]*subject_id_fkey/i.test(f),
      "the subject_id -> places foreign key was dropped by name; a non-null subject must still be a real place",
    );
    assert.ok(
      !/confrelid\s*=\s*'public\.places'::regclass[^;]{0,400}?DROP CONSTRAINT/i.test(f),
      "a catalogue-driven drop removes the subject_id -> places foreign key",
    );
    assert.ok(
      /POSTCONDITION FAILED: the subject_id -> places foreign key was dropped/.test(f),
      "nothing certifies that the FK survived, so a future edit could drop it silently",
    );
  });

  it("a CHECK refuses the two shapes that would smuggle the snap back", () => {
    const f = flat(widener().sql);
    assert.ok(
      /intel_observations_subject_resolution_check/.test(f),
      "no constraint ties the unowned kinds to a null subject; the rule is advisory again",
    );
    // An unowned cluster carrying a place id is the snap. An unowned cluster
    // carrying neither a place nor a zone is an observation of nowhere.
    assert.ok(
      /subject_id IS NULL AND zone_id IS NOT NULL AND subject_kind IN \('temporary_world_object','unknown'\)/.test(f),
      "the unowned arm of the CHECK does not require a zone and forbid a place",
    );
    assert.ok(
      /subject_id IS NOT NULL AND subject_kind NOT IN \('temporary_world_object','unknown'\)/.test(f),
      "the owned arm of the CHECK does not forbid an unowned kind carrying a place id",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The capture path, run for real
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PLACE = "22222222-2222-4222-8222-222222222222";
const ZONE = "33333333-3333-4333-8333-333333333333";
const VENUE_ZONE = "33333333-3333-4333-8333-333333333334";
const OBSERVED = () => new Date(Date.now() - 5 * 60_000).toISOString();

function makeDb(opts: { geoZones?: any[]; places?: any[] } = {}) {
  const reads: string[] = [];
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "map_contributions_enabled", enabled: true },
      { flag: "intel_capture_quick_signal", enabled: true },
    ],
    places: opts.places ?? [{ id: PLACE }],
    geo_zones: opts.geoZones ?? [],
    intel_contribution_consent: [{ user_id: ACTOR, enabled: true, withdrawn_at: null }],
    intel_observations: [],
    intel_claims: [],
  };
  let seq = 0;

  function from(table: string) {
    reads.push(table);
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    const filters: Array<{ col: string; val: any }> = [];
    const match = (row: any) => filters.every((f) => row[f.col] === f.val);

    function run(): { data: any; error: any } {
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...payload };
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      return { data: store.filter(match), error: null };
    }
    const first = () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    };
    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(col: string, val: any) { filters.push({ col, val }); return b; },
      in() { return b; }, is() { return b; }, lte() { return b; }, gte() { return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve(first()); },
      single() { return Promise.resolve(first()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return { from, _tables: tables, _reads: reads } as unknown as SupabaseClient & {
    _tables: typeof tables; _reads: string[];
  };
}

const zoneContribution = (over: Record<string, unknown> = {}) => ({
  objectId: ZONE,
  objectKind: "activity_zone",
  kind: "crowd_direction",
  value: CROWD_DIRECTIONS[0],
  observedAt: OBSERVED(),
  ...over,
});

describe("S97 + S111 — a zone contribution with no owner", () => {
  const plainZone = [{ id: ZONE, zone_type: "neighborhood", metadata: null }];

  it("is stored as `unknown`, against no place, with the zone recorded", async () => {
    const db = makeDb({
      geoZones: plainZone,
      // A place sits in the fixture precisely so that snapping to it would be
      // possible. Nothing may reach for it.
      places: [{ id: PLACE, latitude: 16.06, longitude: 108.22, status: "active", merged_into_place_id: null }],
    });
    const r = await ingestMapContribution(db, ACTOR, zoneContribution());
    assert.equal(r.ok, true, `refused: ${JSON.stringify(r)}`);
    const row = db._tables.intel_observations[0];
    assert.equal(row.subject_id, null, "the zone contribution was filed against a place");
    assert.equal(row.zone_id, ZONE, "the zone it came from is not recorded");
    assert.equal(row.subject_kind, "unknown", "the row does not say that the owner is unknown");
    assert.equal(row.claim_type, "crowd.direction");
  });

  it("never reads `places` at all on that path — there is nothing to be near to", async () => {
    const db = makeDb({
      geoZones: plainZone,
      places: [{ id: PLACE, latitude: 16.06, longitude: 108.22, status: "active", merged_into_place_id: null }],
    });
    await ingestMapContribution(db, ACTOR, zoneContribution());
    assert.ok(
      !db._reads.includes("places"),
      `the route queried \`places\` during a zone contribution (reads: ${db._reads.join(", ")}). A candidate search is the snap, whatever it does with the result.`,
    );
  });

  it("fails closed when the zone id names nothing — never a guess", async () => {
    const db = makeDb({ geoZones: [] });
    const r = await ingestMapContribution(db, ACTOR, zoneContribution());
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unknown_zone");
    assert.equal((r as any).code, "not_found");
    assert.equal(db._tables.intel_observations.length, 0, "something was stored for a zone that does not exist");
  });
});

describe("S111 — an OWNERSHIP signal still resolves, because the rule is about proximity", () => {
  it("a venue zone registered against a place is stored against THAT place", async () => {
    const db = makeDb({
      geoZones: [{ id: VENUE_ZONE, zone_type: "venue", metadata: { place_id: PLACE } }],
      places: [{ id: PLACE }],
    });
    const r = await ingestMapContribution(db, ACTOR, zoneContribution({ objectId: VENUE_ZONE }));
    assert.equal(r.ok, true, `refused: ${JSON.stringify(r)}`);
    const row = db._tables.intel_observations[0];
    assert.equal(row.subject_id, PLACE, "a registered zone -> place mapping is ownership and must resolve");
    assert.equal(row.subject_kind, "experience");
    assert.equal(row.zone_id, VENUE_ZONE, "the zone is still recorded alongside the owner");
  });

  it("resolveZoneSubject answers `unknown` for a venue zone whose metadata names no place", async () => {
    const db = makeDb({ geoZones: [{ id: VENUE_ZONE, zone_type: "venue", metadata: { name: "The Bar" } }] });
    const r = await resolveZoneSubject(db, VENUE_ZONE);
    assert.equal(r.ok, true);
    assert.equal((r as any).subjectId, null);
    assert.equal((r as any).subjectKind, "unknown");
  });
});

describe("S111 — the capture service stores all four outcomes, and refuses the incoherent ones", () => {
  const base = {
    claimType: "crowd.level",
    value: { level: "busy" },
    observedAt: OBSERVED(),
  };

  it("stores a temporary_world_object keyed on its zone", async () => {
    const db = makeDb();
    const r = await writeObservation(db, ACTOR, {
      ...base, subjectId: null, subjectKind: "temporary_world_object", zoneId: ZONE,
      idempotencyKey: "two-1",
    } as any);
    assert.equal(r.ok, true, `refused: ${JSON.stringify(r)}`);
    assert.equal(db._tables.intel_observations[0].subject_id, null);
    assert.equal(db._tables.intel_observations[0].zone_id, ZONE);
  });

  it("refuses an unowned observation that names no zone — that is an observation of nowhere", async () => {
    const db = makeDb();
    const r = await writeObservation(db, ACTOR, {
      ...base, subjectId: null, subjectKind: "unknown", zoneId: null, idempotencyKey: "nz-1",
    } as any);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unknown_subject");
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("refuses an unowned subject kind that carries a place id — the snap, arriving from a caller", async () => {
    const db = makeDb();
    const r = await writeObservation(db, ACTOR, {
      ...base, subjectId: PLACE, subjectKind: "unknown", zoneId: ZONE, idempotencyKey: "mix-1",
    } as any);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unknown_subject");
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("an unowned observation may not become a CLAIM — a claim is a proposition about a place", async () => {
    const db = makeDb();
    const r = await proposeClaim(db, {
      id: "obs-1", subject_kind: "unknown", subject_id: null, zone_id: ZONE,
      claim_type: "crowd.level", value: { level: "busy" }, moderation_state: "allowed",
      observed_at: OBSERVED(), capture_surface: "quick_signal", source_class: "firsthand_unverified",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unresolved_subject");
    assert.equal(db._tables.intel_claims.length, 0, "a claim was minted for a cluster with no place");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. The rule itself, unchanged and now reachable
// ─────────────────────────────────────────────────────────────────────────────

describe("S111 — proximity is still not ownership, and now the answer has somewhere to go", () => {
  it("the nearest candidate resolves to `unknown`, not to that place", () => {
    const ref = reconcileSensingSubject({
      zoneId: ZONE,
      candidates: [{ kind: "place", id: PLACE, evidence: "proximity" }],
    });
    assert.equal(ref.kind, "unknown");
    const stored = subjectStorageFor(ref);
    assert.equal(stored.subjectId, null, "a proximity candidate reached the subject column");
    assert.equal(stored.zoneId, ZONE);
  });

  it("every one of §18.3's four outcomes maps onto a storable row shape", () => {
    const shapes = [
      subjectStorageFor({ kind: "place", id: PLACE, evidence: "venue_anchor" }, { zoneId: ZONE }),
      subjectStorageFor({ kind: "event", id: "e1", evidence: "event_qr" }, { zoneId: ZONE }),
      subjectStorageFor({ kind: "temporary_world_object", zoneId: ZONE }),
      subjectStorageFor({ kind: "unknown", zoneId: ZONE }),
    ];
    for (const s of shapes) {
      const owned = s.subjectId !== null;
      const unownedKind = s.subjectKind === "unknown" || s.subjectKind === "temporary_world_object";
      // The same predicate intel_observations_subject_resolution_check enforces.
      assert.ok(
        (owned && !unownedKind) || (!owned && s.zoneId !== null && unownedKind),
        `${JSON.stringify(s)} would be refused by intel_observations_subject_resolution_check`,
      );
    }
    assert.equal(new Set(shapes.map((s) => s.subjectKind)).size, 4, "two outcomes collapsed onto one subject kind");
  });
});
