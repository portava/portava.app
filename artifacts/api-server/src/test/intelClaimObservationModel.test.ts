/**
 * I1 — claim/observation model (migration 2274): structural contract, and the
 * invariant the nullable actor must not weaken.
 *
 * Structural, like intelStorage.test.ts: the properties protected ARE
 * properties of the migration text (which columns exist, which CHECKs bound
 * them, that idempotency has a unique index behind it) and of EVERY policy on
 * the intel tables across ALL migrations (that a NULL actor can satisfy none of
 * them). The live-DB tier certifies the apply; this file refuses a text edit
 * that would let a NULL-actor row through before it ever reaches a database.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SOURCE_CLASSES, CLAIM_STATUSES } from "../lib/intelContracts.js";
import { SOURCE_LABEL_BY_CLASS, sourceLabelFor } from "../services/intel/IntelCaptureService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");
const SQL = readFileSync(join(MIGRATIONS, "2274_intel_claim_observation_model.sql"), "utf8");
const STORAGE_SQL = readFileSync(join(MIGRATIONS, "2130_intel_storage.sql"), "utf8");

const TABLE5_SOURCE_LABELS = ["official", "verified_firsthand", "consensus", "historical", "prediction", "sponsored", "unverified"];
const TABLE4_STATES = ["draft", "submitted", "processing", "published", "corrected", "expired", "rejected", "restricted", "removed", "reconfirmed"];
/** Table 3: "Null only for signed official/system sources". */
const ACTORLESS_SOURCE_CLASSES = ["official_signed", "portava_prediction", "historical_pattern"];

describe("2274 — intel_claims Table-5 fields + version pair", () => {
  it("is a single transaction with a conditional-RAISE postcondition block", () => {
    assert.match(SQL, /^BEGIN;/m);
    assert.match(SQL, /^COMMIT;/m);
    assert.match(SQL, /Postconditions/);
    assert.ok((SQL.match(/RAISE EXCEPTION 'POSTCONDITION FAILED/g) ?? []).length >= 8);
  });

  it("adds every Table-5 column additively (IF NOT EXISTS) and nullable except the defaulted version pair", () => {
    for (const c of ["observation_id", "qualifiers_json", "asserted_confidence", "source_label", "lineage"]) {
      assert.match(SQL, new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\s+\\w+(?![^,]*NOT NULL)`), `${c} must be nullable`);
    }
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS updated_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS version\s+integer NOT NULL DEFAULT 1/);
  });

  it("bounds each Table-5 field with a CHECK (object / 0–1 / registry label / version >= 1)", () => {
    assert.match(SQL, /intel_claims_qualifiers_json_object[\s\S]*jsonb_typeof\(qualifiers_json\) = 'object'/);
    assert.match(SQL, /intel_claims_asserted_confidence_range[\s\S]*asserted_confidence >= 0 AND asserted_confidence <= 1/);
    assert.match(SQL, /intel_claims_lineage_object[\s\S]*jsonb_typeof\(lineage\) = 'object'/);
    assert.match(SQL, /intel_claims_version_positive[\s\S]*version >= 1/);
    const labels = SQL.match(/intel_claims_source_label_check[\s\S]*?\(([^)]*)\)\);/)?.[1] ?? "";
    for (const l of TABLE5_SOURCE_LABELS) assert.ok(labels.includes(`'${l}'`), `source_label CHECK missing '${l}'`);
  });

  it("makes proposeClaim idempotent: a partial UNIQUE on (observation_id, claim_type)", () => {
    assert.match(SQL, /CREATE UNIQUE INDEX IF NOT EXISTS intel_claims_one_per_observation_type\s+ON public\.intel_claims \(observation_id, claim_type\)\s+WHERE observation_id IS NOT NULL/);
  });

  it("the lineage root FK is SET NULL, never CASCADE — erasing a contributor must not delete the aggregate", () => {
    assert.match(SQL, /observation_id\s+uuid REFERENCES public\.intel_observations\(id\) ON DELETE SET NULL/);
    assert.doesNotMatch(SQL, /intel_observations\(id\) ON DELETE CASCADE/);
  });

  it("bumps version + updated_at on every UPDATE through a trigger that is not callable over REST", () => {
    assert.match(SQL, /CREATE OR REPLACE FUNCTION public\.intel_claims_bump_version\(\)[\s\S]*NEW\.updated_at := now\(\);[\s\S]*NEW\.version := COALESCE\(OLD\.version, 0\) \+ 1;/);
    assert.match(SQL, /CREATE TRIGGER intel_claims_bump_version\s+BEFORE UPDATE ON public\.intel_claims\s+FOR EACH ROW/);
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      assert.match(SQL, new RegExp(`REVOKE ALL ON FUNCTION public\\.intel_claims_bump_version\\(\\) FROM ${role};`));
    }
  });

  it("the registry of claim statuses is unchanged — 2274 adds fields, not lifecycle states", () => {
    assert.doesNotMatch(SQL, /intel_claims_status_check/);
    assert.deepEqual([...CLAIM_STATUSES], ["candidate", "active", "conflicting", "superseded", "expired", "retracted", "rejected"]);
  });
});

describe("2274 — intel_observations Table-4 lifecycle + Table-3 nullable actor", () => {
  it("adds lifecycle_state NOT NULL DEFAULT 'submitted' with the Table-4 vocabulary as its CHECK", () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'submitted'/);
    const states = SQL.match(/intel_observations_lifecycle_state_check[\s\S]*?\(([^)]*)\)\);/)?.[1] ?? "";
    for (const s of TABLE4_STATES) assert.ok(states.includes(`'${s}'`), `lifecycle CHECK missing '${s}'`);
    assert.ok(!states.includes("'deleted'"), "'deleted' is an erasure, not a row state on an append-only table");
  });

  it("actor_id becomes nullable ONLY with the official/system CHECK beside it", () => {
    assert.match(SQL, /ALTER TABLE public\.intel_observations ALTER COLUMN actor_id DROP NOT NULL;/);
    const check = SQL.match(/intel_observations_actor_required_unless_official_system\s+CHECK \(([^;]*)\);/)?.[1] ?? "";
    assert.match(check, /actor_id IS NOT NULL OR source_class IN \(/);
    for (const c of ACTORLESS_SOURCE_CLASSES) assert.ok(check.includes(`'${c}'`), `${c} may be actor-less`);
    // Every OTHER registry class still requires an actor.
    for (const c of SOURCE_CLASSES) {
      if (ACTORLESS_SOURCE_CLASSES.includes(c)) continue;
      assert.ok(!check.includes(`'${c}'`), `${c} must still require an actor (Table 3: null only for official/system)`);
    }
    // The postcondition refuses to commit without the CHECK.
    assert.match(SQL, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'intel_observations_actor_required_unless_official_system'\) THEN\s+RAISE EXCEPTION/);
  });

  it("actor-less rows get their own idempotency index (NULLs are distinct under the actor-keyed one)", () => {
    assert.match(SQL, /CREATE UNIQUE INDEX IF NOT EXISTS intel_observations_system_idempotency\s+ON public\.intel_observations \(source_class, idempotency_key\)\s+WHERE actor_id IS NULL/);
  });

  it("adds NO policy and NO grant — nothing widens for anon or authenticated", () => {
    assert.doesNotMatch(SQL, /CREATE POLICY/);
    assert.doesNotMatch(SQL, /^\s*GRANT /m);
    assert.match(SQL, /grantee IN \('anon','authenticated'\)[\s\S]*RAISE EXCEPTION 'POSTCONDITION FAILED: anon\/authenticated hold/);
    assert.match(SQL, /privilege_type IN \('UPDATE','DELETE','TRUNCATE'\)[\s\S]*append-only intel_observations/);
  });

  it("re-reads the own-row policy from pg_policy and refuses any shape a NULL actor could satisfy", () => {
    assert.match(SQL, /pg_get_expr\(polqual, polrelid\)[\s\S]*polname = 'intel_observations_select_own'/);
    assert.match(SQL, /policy_expr !~ '\^\\\(\?actor_id = auth\\\.uid\\\(\\\)\\\)\?\$'/);
  });
});

// ── The invariant: every own-row policy on an intel table fails closed for NULL actor ──
//
// RLS evaluates USING/WITH CHECK as a boolean; NULL is not true, so a row is
// admitted only when the predicate is TRUE. `actor_id = auth.uid()` with a NULL
// actor_id is NULL → denied. That holds ONLY while the predicate is the bare
// equality: `actor_id IS NULL OR …`, `coalesce(actor_id, auth.uid()) = auth.uid()`
// or a `true` branch would admit the actor-less row to a client. This scans the
// policy text of EVERY migration so no later file can quietly add such a shape.
interface Policy { file: string; name: string; table: string; roles: string; using: string | null; withCheck: string | null }

function extractIntelPolicies(dir: string): Policy[] {
  const out: Policy[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    const re = /CREATE POLICY\s+(\w+)\s+ON\s+public\.(intel_\w+)([\s\S]*?);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      const body = m[3];
      const roles = body.match(/\bTO\s+([\w, ]+?)\s+(?:USING|WITH CHECK|FOR|$)/)?.[1]?.trim() ?? "PUBLIC";
      const using = body.match(/USING\s*\(([\s\S]*?)\)\s*(?:WITH CHECK|$)/)?.[1]?.trim() ?? null;
      const withCheck = body.match(/WITH CHECK\s*\(([\s\S]*?)\)\s*$/)?.[1]?.trim() ?? null;
      out.push({ file, name: m[1], table: m[2], roles, using, withCheck });
    }
  }
  return out;
}

/** The one shape a NULL identity column can never satisfy. */
const BARE_OWN_ROW = /^\(?\s*(actor_id|user_id)\s*=\s*auth\.uid\(\)\s*\)?$/;

/**
 * Evaluate a predicate for a row whose identity column is NULL, three-valued:
 * the bare equality is NULL (denied); anything mentioning IS NULL / coalesce /
 * OR / a bare true is treated as potentially TRUE (admits) and refused.
 */
function admitsNullActor(pred: string): boolean {
  if (BARE_OWN_ROW.test(pred)) return false;
  return /\bIS\s+NULL\b|coalesce\s*\(|\bOR\b|^\s*true\s*$|\btrue\b/i.test(pred) || !/(actor_id|user_id)/.test(pred);
}

describe("every own-row RLS policy on an intel table fails closed for a NULL actor", () => {
  const policies = extractIntelPolicies(MIGRATIONS);

  it("finds the intel policies (the scan has a subject)", () => {
    assert.ok(policies.length >= 3, `expected ≥3 intel policies, found ${policies.length}`);
    assert.ok(policies.some((p) => p.name === "intel_observations_select_own"));
  });

  it("a client-facing policy is the bare own-row equality, which a NULL identity can never satisfy", () => {
    for (const p of policies) {
      if (p.roles === "service_role") continue; // covered below
      for (const pred of [p.using, p.withCheck]) {
        if (pred === null) continue;
        assert.ok(!admitsNullActor(pred), `${p.file} ${p.name} on ${p.table}: "${pred}" could admit a NULL-actor row to ${p.roles}`);
        assert.match(pred, BARE_OWN_ROW, `${p.file} ${p.name}: expected the bare own-row equality, got "${pred}"`);
      }
      assert.ok(/^(authenticated|anon|PUBLIC)$/.test(p.roles), `${p.name}: unexpected role list "${p.roles}"`);
      assert.notEqual(p.roles, "anon", `${p.name}: anon must never hold an intel policy`);
    }
  });

  it("a USING (true) policy exists only for service_role, never for a client role", () => {
    for (const p of policies) {
      const open = [p.using, p.withCheck].some((x) => x !== null && /^\s*true\s*$/i.test(x));
      if (open) assert.equal(p.roles, "service_role", `${p.file} ${p.name} on ${p.table} is open (true) for ${p.roles}`);
    }
  });

  it("the erasure entry point refuses a NULL actor rather than deleting nothing-or-everything", () => {
    assert.match(STORAGE_SQL, /IF p_actor_id IS NULL THEN\s+RAISE EXCEPTION/);
  });

  it("the client SELECT grant on intel_observations is still paired with exactly that own-row policy", () => {
    assert.match(STORAGE_SQL, /GRANT SELECT ON public\.intel_observations\s+TO authenticated;/);
    assert.match(STORAGE_SQL, /CREATE POLICY intel_observations_select_own ON public\.intel_observations\s+FOR SELECT TO authenticated USING \(actor_id = auth\.uid\(\)\);/);
  });
});

describe("proposeClaim source_label — Table 5 registry from the source class", () => {
  it("maps every registry source class to a Table-5 label, never to 'consensus'", () => {
    for (const c of SOURCE_CLASSES) {
      const l = sourceLabelFor(c);
      assert.ok(TABLE5_SOURCE_LABELS.includes(l), `${c} → ${l} is not a Table-5 label`);
      assert.notEqual(l, "consensus", "a single proposal is never consensus; the projection earns that over a cohort");
    }
    assert.equal(SOURCE_LABEL_BY_CLASS.official_signed, "official");
    assert.equal(SOURCE_LABEL_BY_CLASS.portava_prediction, "prediction", "a prediction is labeled as one (§1: never rendered as an observation)");
    assert.equal(SOURCE_LABEL_BY_CLASS.historical_pattern, "historical");
    assert.equal(SOURCE_LABEL_BY_CLASS.sponsored, "sponsored");
    assert.equal(SOURCE_LABEL_BY_CLASS.hearsay, "unverified");
  });

  it("fails closed: unknown or malformed source class → 'unverified'", () => {
    assert.equal(sourceLabelFor("not_a_class"), "unverified");
    assert.equal(sourceLabelFor(null), "unverified");
    assert.equal(sourceLabelFor(undefined), "unverified");
    assert.equal(sourceLabelFor(42), "unverified");
  });
});
