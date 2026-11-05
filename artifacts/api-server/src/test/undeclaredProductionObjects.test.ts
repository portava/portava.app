/**
 * check:undeclared-production-objects — production objects no migration in this
 * tree declares, the reverse direction of check:production-drift.
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * The 2026-10-24 capability refresh (PR #788) found by hand that production held
 * a chunked-upload store, a deletion lease and a dormant journey-shadow programme
 * that no file in this repository creates, and that nothing had gone red when
 * they arrived. The first prototype of this check then reported 26 undeclared
 * tables and 37 undeclared columns, of which only 11 and 12 were real: the rest
 * were views the capture lists with their query's columns (buddy_bookings is a
 * 0050 table replaced by 0147's view over rent_buddy_bookings, created inside a
 * DO block's EXECUTE string) and the three relations `CREATE EXTENSION postgis`
 * brings with it. Both parser gaps are pinned below against the real corpus,
 * because a check that reports a declared view as out-of-band DDL is the false
 * failure lib/canonicalSchema.ts's posture exists to prevent.
 *
 * WHAT WOULD TURN THIS RED: drop the view pass from collectDeclarations and the
 * buddy_bookings case fails; drop EXTENSION_RELATIONS and spatial_ref_sys fails;
 * make undeclaredObjects judge a view's columns and the fixture case fails;
 * delete any one entry from UNDECLARED_PRODUCTION_OBJECTS and the HEAD case goes
 * red naming it; add an entry for something the tree declares and the real-ratchet
 * case reports it as nowDeclared.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/undeclaredProductionObjects.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UNDECLARED_PRODUCTION_OBJECTS,
  EXTENSION_RELATIONS,
  captureHolds,
  collectDeclarations,
  extensionRelationsFor,
  normaliseCapture,
  ratchetVerdict,
  readProductionCapture,
  readTreeDeclarations,
  splitKey,
  undeclaredObjects,
  undeclaredProductionColumns,
  type ProductionCapture,
  type RatchetEntry,
  type TreeDeclarations,
} from "../scripts/checkUndeclaredProductionObjects.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function tree(partial: {
  tables?: Record<string, string[]>;
  unmodelled?: string[];
  relations?: string[];
  views?: string[];
  functions?: string[];
  enums?: string[];
}): TreeDeclarations {
  const tables = new Map<string, Set<string>>();
  for (const [t, cols] of Object.entries(partial.tables ?? {})) tables.set(t, new Set(cols));
  return {
    tables,
    unmodelled: new Set(partial.unmodelled ?? []),
    relations: new Set([...Object.keys(partial.tables ?? {}), ...(partial.relations ?? []), ...(partial.views ?? [])]),
    views: new Set(partial.views ?? []),
    functions: new Set(partial.functions ?? []),
    enums: new Set(partial.enums ?? []),
    sources: { baseline: "fixture", migrationFiles: 0 },
  };
}

function capture(partial: Partial<{ tables: Record<string, string[]>; functions: string[]; enums: string[] }>): ProductionCapture {
  return normaliseCapture({ tables: partial.tables ?? {}, functions: partial.functions ?? [], enums: partial.enums ?? [] });
}

const entry = (decision: RatchetEntry["decision"]): RatchetEntry => ({ decision, note: "fixture" });

// ── The text parse ───────────────────────────────────────────────────────────

describe("collectDeclarations reads every kind of name the tree creates", () => {
  it("tables, views, materialized views, functions, procedures, enums and extensions", () => {
    const d = collectDeclarations(`
      CREATE TABLE IF NOT EXISTS public.alpha (id uuid);
      create unlogged table "beta" (id uuid);
      CREATE OR REPLACE VIEW gamma AS SELECT 1;
      CREATE MATERIALIZED VIEW IF NOT EXISTS public.delta AS SELECT 1;
      CREATE OR REPLACE FUNCTION public.f_one(uuid) RETURNS void LANGUAGE sql AS $$ select 1 $$;
      CREATE PROCEDURE p_two() LANGUAGE sql AS $$ select 1 $$;
      CREATE TYPE public.mood AS ENUM ('up', 'down');
      CREATE EXTENSION IF NOT EXISTS postgis;
    `);
    assert.deepEqual([...d.relations].sort(), ["alpha", "beta", "delta", "gamma"]);
    assert.deepEqual([...d.views].sort(), ["delta", "gamma"]);
    assert.deepEqual([...d.functions].sort(), ["f_one", "p_two"]);
    assert.deepEqual([...d.enums], ["mood"]);
    assert.deepEqual([...d.extensions], ["postgis"]);
  });

  it("DDL inside a DO block's EXECUTE string counts — that is how 0147 creates buddy_bookings", () => {
    const d = collectDeclarations(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'later') THEN
          EXECUTE $q$ CREATE OR REPLACE VIEW later AS SELECT id FROM earlier $q$;
        END IF;
      END $$;
    `);
    assert.ok(d.views.has("later"));
    assert.ok(d.relations.has("later"));
  });

  it("a comment declares nothing; a CREATE TYPE that is not an enum is not an enum", () => {
    const d = collectDeclarations(`
      -- create table ghost_a (id uuid);
      /* create view ghost_b as select 1; */
      CREATE TYPE composite_thing AS (a int, b int);
      CREATE DOMAIN positive AS integer CHECK (VALUE > 0);
    `);
    assert.equal(d.relations.size, 0);
    assert.equal(d.views.size, 0);
    assert.equal(d.enums.size, 0);
  });

  it("extension relations are declared only when the tree installs the extension", () => {
    assert.deepEqual([...extensionRelationsFor(new Set())], []);
    assert.deepEqual(
      [...extensionRelationsFor(new Set(["postgis"]))].sort(),
      [...EXTENSION_RELATIONS.postgis!].sort(),
    );
    assert.deepEqual([...extensionRelationsFor(new Set(["pg_trgm", "vector"]))], []);
  });
});

// ── The comparison ───────────────────────────────────────────────────────────

describe("undeclaredObjects judges presence everywhere and columns only on modelled base tables", () => {
  const t = tree({
    tables: { profiles: ["id", "name"], loose: ["id"] },
    unmodelled: ["loose"],
    views: ["profiles_public"],
    relations: ["spatial_ref_sys"],
    functions: ["f_known"],
    enums: ["mood"],
  });

  it("a relation the tree never names is undeclared; its columns are not reported on top", () => {
    const c = capture({ tables: { mystery: ["id", "secret"] } });
    assert.deepEqual(undeclaredObjects(c, t), ["table:mystery"]);
  });

  it("a column the tree never adds to a modelled base table is undeclared", () => {
    const c = capture({ tables: { profiles: ["id", "name", "shadow"] } });
    assert.deepEqual(undeclaredObjects(c, t), ["column:profiles.shadow"]);
  });

  it("a view's columns are never judged, even when the tree also built a table of that name", () => {
    const withBoth = tree({ tables: { profiles_public: ["id"] }, views: ["profiles_public"] });
    const c = capture({ tables: { profiles_public: ["id", "name", "from_the_query"] } });
    assert.deepEqual(undeclaredObjects(c, withBoth), []);
    assert.deepEqual(undeclaredObjects(c, t), []);
  });

  it("an unmodelled table and an extension relation are judged by presence only", () => {
    const c = capture({ tables: { loose: ["id", "whatever"], spatial_ref_sys: ["srid", "auth_name"] } });
    assert.deepEqual(undeclaredObjects(c, t), []);
  });

  it("functions and enums by name, and the output is sorted", () => {
    const c = capture({
      tables: { profiles: ["id"] },
      functions: ["f_known", "f_unknown"],
      enums: ["mood", "weather"],
    });
    assert.deepEqual(undeclaredObjects(c, t), ["enum:weather", "function:f_unknown"]);
  });

  it("names compare the way Postgres folds them: case-insensitively", () => {
    const c = normaliseCapture({ tables: { Profiles: ["ID", "Name"] }, functions: ["F_KNOWN"], enums: ["MOOD"] });
    assert.deepEqual(undeclaredObjects(c, t), []);
  });
});

describe("ratchetVerdict fails in every direction the ratchet can rot", () => {
  const c = capture({
    tables: { ghost: ["id"], profiles: ["id", "shadow"] },
    functions: ["f_ghost"],
  });
  const undeclared = ["column:profiles.shadow", "function:f_ghost", "table:ghost"];

  it("an undeclared object not on the ratchet is unrecorded", () => {
    const v = ratchetVerdict({ "table:ghost": entry("owner-pending") }, undeclared, c);
    assert.deepEqual(v.unrecorded, ["column:profiles.shadow", "function:f_ghost"]);
    assert.deepEqual(v.nowDeclared, []);
    assert.deepEqual(v.gone, []);
  });

  it("a ratcheted object the tree now declares is nowDeclared", () => {
    // profiles.id is in the capture and (by construction) not undeclared.
    const v = ratchetVerdict({ "column:profiles.id": entry("codify") }, undeclared, c);
    assert.deepEqual(v.nowDeclared, ["column:profiles.id"]);
  });

  it("a ratcheted object the capture no longer holds is gone", () => {
    const v = ratchetVerdict(
      { "table:dropped": entry("drop"), "column:profiles.old": entry("drop"), "enum:gone": entry("keep") },
      undeclared,
      c,
    );
    assert.deepEqual(v.gone, ["column:profiles.old", "enum:gone", "table:dropped"]);
  });

  it("a complete, true ratchet is clean in all three directions", () => {
    const v = ratchetVerdict(
      Object.fromEntries(undeclared.map((k) => [k, entry("owner-pending")])),
      undeclared,
      c,
    );
    assert.deepEqual(v, { unrecorded: [], nowDeclared: [], gone: [] });
  });

  it("captureHolds reads each kind where the capture keeps it", () => {
    assert.ok(captureHolds(c, "table:ghost"));
    assert.ok(captureHolds(c, "column:profiles.shadow"));
    assert.ok(!captureHolds(c, "column:profiles.nope"));
    assert.ok(!captureHolds(c, "column:nope.id"));
    assert.ok(captureHolds(c, "function:f_ghost"));
    assert.ok(!captureHolds(c, "enum:anything"));
  });

  it("a malformed key is refused rather than silently never matching", () => {
    assert.throws(() => splitKey("ghost"), /kind:name/);
    assert.throws(() => splitKey("index:ghost_idx"), /kind:name/);
    assert.throws(() => splitKey("column:no_dot"), /column:table\.column/);
    assert.deepEqual(splitKey("column:t.c"), ["column", "t.c"]);
  });
});

// ── The real tree, the real capture, the real ratchet ────────────────────────

describe("the real tree, against the current capture", () => {
  const prod = readProductionCapture();
  const real = readTreeDeclarations();
  const undeclared = undeclaredObjects(prod, real);
  const verdict = ratchetVerdict(UNDECLARED_PRODUCTION_OBJECTS, undeclared, prod);

  it("the first prototype's false findings are declared: the compatibility views, created inside DO blocks", () => {
    for (const v of ["buddy_bookings", "buddy_profiles", "buddy_reviews", "buddy_booking_requests"]) {
      assert.ok(real.views.has(v), `${v} is created as a view (0108/0134/0147) and must be judged by presence only`);
      assert.ok(v in prod.tables, `${v} is in the capture, so the case is live`);
    }
  });

  it("PostGIS's relations are declared because 2030 installs the extension", () => {
    for (const r of EXTENSION_RELATIONS.postgis!) {
      assert.ok(real.relations.has(r), `${r} comes with CREATE EXTENSION postgis`);
    }
  });

  it("a function the text declares but the local replay cannot build still counts as declared", () => {
    // 3982's visual-index functions: the replay runs a pgvector stand-in, which is
    // exactly why PR #788 asked for a parse of the text and not the replay's catalogue.
    assert.ok(real.functions.has("media_visual_index_commit"));
    assert.ok(prod.functions.includes("media_visual_index_commit"));
  });

  it("a function only production has is not declared (negative control)", () => {
    // commit_media_upload_chunk served here until 4001 codified it on 2026-11-04;
    // the journey-shadow programme's functions are still production-only.
    assert.ok(!real.functions.has("set_journey_observation_consent_v1"));
    assert.ok(prod.functions.includes("set_journey_observation_consent_v1"));
    assert.ok(real.functions.has("commit_media_upload_chunk"), "4001 declares the upload commit now");
  });

  it("nothing in production is undeclared and unrecorded", () => {
    assert.deepEqual(verdict.unrecorded, [], `out-of-band objects not on the ratchet: ${verdict.unrecorded.join(", ")}`);
  });

  it("no ratchet entry has been codified without being struck off", () => {
    assert.deepEqual(verdict.nowDeclared, [], `now declared by the tree: ${verdict.nowDeclared.join(", ")}`);
  });

  it("no ratchet entry names something the capture no longer holds", () => {
    assert.deepEqual(verdict.gone, [], `gone from the capture: ${verdict.gone.join(", ")}`);
  });

  it("every ratchet entry carries a well-formed key, a known decision and a reason that cites the census", () => {
    const decisions = new Set(["owner-pending", "codify", "drop", "keep"]);
    for (const [key, e] of Object.entries(UNDECLARED_PRODUCTION_OBJECTS)) {
      assert.doesNotThrow(() => splitKey(key));
      assert.ok(decisions.has(e.decision), `${key}: decision ${e.decision}`);
      assert.match(e.note, /census-media\.md/, `${key}: the note must say where the object is recorded`);
      assert.ok(e.note.length > 80, `${key}: a one-liner is not a reason`);
    }
  });

  it("the ratchet's columns are the list checkSchemaReferences tolerates: the six journey columns it kept by hand, and no longer the three lease columns 4002 declares", () => {
    const cols = undeclaredProductionColumns();
    for (const c of [
      "user_deletion_requests.execution_lease_expires_at",
      "user_deletion_requests.execution_started_at",
      "user_deletion_requests.execution_token",
    ]) {
      assert.ok(!cols.has(c), `${c} is declared by 4002 since 2026-11-04 and must no longer be tolerated as undeclared`);
    }
    for (const c of [
      "location_sessions.journey_purpose",
      "user_location_preferences.journey_consent_granted_at",
      "user_location_preferences.journey_consent_revoked_at",
      "user_location_preferences.journey_consent_scope",
      "user_location_preferences.journey_consent_version",
      "user_location_preferences.journey_observation_enabled",
    ]) {
      assert.ok(cols.has(c), `${c} was on UNDECLARED_LIVE_COLUMNS since 2026-09-04 and must still be tolerated`);
    }
    assert.equal(
      cols.size,
      Object.keys(UNDECLARED_PRODUCTION_OBJECTS).filter((k) => k.startsWith("column:")).length,
    );
  });
});

// Like check:production-drift's HEAD case: the real entry point, in the
// credential-free tier, so the verdict is never masked behind a live-DB job.
describe("check:undeclared-production-objects at HEAD (credential-free)", () => {
  it("the script itself exits 0 and says so", async () => {
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "src/scripts/checkUndeclaredProductionObjects.ts"],
      {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /✓ Every production object is declared by the tree or on the ratchet\. [0-9]+ object\(s\) on the ratchet/);
    assert.match(run.stdout, /no credentials were used, and no database was contacted/);
  });
});
