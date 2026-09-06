/**
 * IG SQL FUNCTION CONTRACTS — the four function bodies nothing else checks.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Everything irreversible in Intelligence Gathering lives in SQL:
 *
 *   • system_promote_admissible_intel_claims (2174) — autonomously turns an
 *     observation into an ACTIVE claim. Its WHERE clause IS the admissibility
 *     policy: consent, moderation, freshness and the aggregate-only rule.
 *   • purge_intel_contributions_older_than (2173) — the 180-day retention DELETE.
 *   • purge_expired_intel_snapshots (2133) — the snapshot expiry DELETE.
 *   • erase_intel_for_actor (2130, widened by 2278) — the account-deletion DELETE.
 *
 * The TypeScript AROUND them is mutation-proven (intelPromotionRetention,
 * intelRetention, accountDeletionCascade): the flags, the RPC names, the
 * arguments, the fail-closed skips. The BODIES were asserted only by their own
 * migration postconditions, and the promotion test asserted the RPC NAME STRING,
 * not one line of the policy it invokes. Delete `AND c.enabled = true` from 2174
 * and every one of those tests still passes while withdrawn contributors' rows
 * start becoming live claims.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * ======================================
 * This is a STATIC CONTRACT test over the migration text, not an execution test:
 * it cannot prove Postgres semantics and does not claim to. What it does prove is
 * that each load-bearing guard is PRESENT and cannot be removed silently, and —
 * the part no human review reliably catches — that the SQL's hardcoded literals
 * still equal the TypeScript constants they duplicate. Every expected literal
 * below is DERIVED from the module that owns it; none is typed out here. If
 * PILOT_CLAIMABLE_MODERATION_STATES gains a state, or mustAggregate() covers a
 * second claim type, this test goes red until 2174 is brought along.
 *
 * "Certified against real Postgres" (the note at the head of
 * intelPromotionRetention.test.ts) is a separate, out-of-band activity. This is
 * the in-repo ratchet that stops the bodies drifting between certifications.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PILOT_CLAIMABLE_MODERATION_STATES, MODERATION_STATES, CLAIM_TYPES } from "../lib/intelContracts.js";
import { mustAggregate } from "../lib/trailFollowup.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Every migration file, ordered by its numeric prefix — apply order. */
function migrationsInOrder(): { file: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => (Number(a.split("_")[0]) || 0) - (Number(b.split("_")[0]) || 0))
    .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS, file), "utf8") }));
}

/**
 * The body of `public.<name>` AS LAST DEFINED. A CREATE OR REPLACE in a later
 * migration is the definition production runs — erase_intel_for_actor is defined
 * in 2130 and REPLACED in 2278, and reading 2130's body would test a function
 * that no longer exists.
 */
function latestFunctionBody(name: string): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  for (const { file, sql } of migrationsInOrder()) {
    const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      const end = sql.indexOf("\n$$;", m.index);
      assert.ok(end > m.index, `${file}: could not find the end of ${name}`);
      found = { file, body: sql.slice(m.index, end + 4) };
    }
  }
  assert.ok(found, `no migration defines public.${name}`);
  return found;
}

/** The grant block for a function, gathered across every migration that touches it. */
function grantLinesFor(name: string): string[] {
  const lines: string[] = [];
  for (const { sql } of migrationsInOrder()) {
    for (const line of sql.split("\n")) {
      if (/^\s*(REVOKE|GRANT)\b/.test(line) && line.includes(`FUNCTION public.${name}(`)) lines.push(line.trim());
    }
  }
  return lines;
}

/** Collapse whitespace so a reformat of the SQL does not break a substring check. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const IRREVERSIBLE = [
  "purge_intel_contributions_older_than",
  "purge_expired_intel_snapshots",
  "erase_intel_for_actor",
  "system_promote_admissible_intel_claims",
] as const;

// ── Posture shared by all four ────────────────────────────────────────────────

describe("IG SQL functions — definer posture and grants", () => {
  for (const name of IRREVERSIBLE) {
    it(`${name} is SECURITY DEFINER with a pinned empty search_path`, () => {
      const { body } = latestFunctionBody(name);
      const f = flat(body);
      assert.ok(f.includes("SECURITY DEFINER"), `${name} must be SECURITY DEFINER`);
      // An unpinned search_path on a definer function is the classic hijack:
      // a caller-controlled schema can shadow `public.intel_observations`.
      assert.ok(/SET search_path = ''/.test(f), `${name} must pin search_path to ''`);
    });

    it(`${name} is executable by service_role ONLY`, () => {
      const lines = grantLinesFor(name);
      assert.ok(lines.length > 0, `${name} has no grant block at all`);
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        assert.ok(
          lines.some((l) => l.startsWith("REVOKE ALL") && l.endsWith(`FROM ${role};`)),
          `${name}: EXECUTE must be revoked from ${role}`,
        );
      }
      const grants = lines.filter((l) => l.startsWith("GRANT"));
      assert.ok(grants.length > 0, `${name}: nothing is granted EXECUTE`);
      for (const g of grants) {
        assert.ok(g.endsWith("TO service_role;"), `${name}: unexpected grantee in \`${g}\``);
      }
    });
  }
});

// ── The three DELETEs: never unbounded ────────────────────────────────────────

describe("IG SQL functions — no irreversible DELETE is unbounded", () => {
  const DELETERS = [
    "purge_intel_contributions_older_than",
    "purge_expired_intel_snapshots",
    "erase_intel_for_actor",
  ] as const;

  for (const name of DELETERS) {
    it(`${name}: every DELETE carries a WHERE clause`, () => {
      const { body } = latestFunctionBody(name);
      const deletes = flat(body).match(/DELETE FROM public\.[a-z_]+[^;]*;/g) ?? [];
      assert.ok(deletes.length > 0, `${name} is a deleter with no DELETE`);
      for (const d of deletes) {
        assert.ok(/\bWHERE\b/.test(d), `${name}: unbounded DELETE — \`${d}\``);
      }
    });

    it(`${name}: declares the erasure so the append-only triggers permit the DELETE`, () => {
      const { body } = latestFunctionBody(name);
      assert.ok(
        flat(body).includes("set_config('portava.erasure_in_progress'"),
        `${name} must declare the erasure; without it the append-only trigger refuses and the sweep silently deletes nothing`,
      );
    });
  }

  it("purge_intel_contributions_older_than REFUSES a null cutoff (which would purge everything)", () => {
    const { body } = latestFunctionBody("purge_intel_contributions_older_than");
    const f = flat(body);
    assert.ok(/IF p_cutoff IS NULL THEN RAISE EXCEPTION/.test(f), "a null cutoff must raise, not delete");
    // ...and every DELETE is bounded BY that cutoff, not by something else.
    for (const d of f.match(/DELETE FROM public\.[a-z_]+[^;]*;/g) ?? []) {
      assert.ok(d.includes("< p_cutoff"), `retention DELETE not bounded by the cutoff: \`${d}\``);
    }
  });

  it("erase_intel_for_actor REFUSES a null actor and scopes every DELETE to that actor", () => {
    const { body } = latestFunctionBody("erase_intel_for_actor");
    const f = flat(body);
    assert.ok(/IF p_actor_id IS NULL THEN RAISE EXCEPTION/.test(f), "a null actor must raise, not erase everyone");
    for (const d of f.match(/DELETE FROM public\.[a-z_]+[^;]*;/g) ?? []) {
      assert.ok(d.includes("actor_id = p_actor_id"), `erasure DELETE not scoped to the actor: \`${d}\``);
    }
  });

  it("purge_expired_intel_snapshots deletes only rows that have actually expired", () => {
    const f = flat(latestFunctionBody("purge_expired_intel_snapshots").body);
    assert.ok(f.includes("DELETE FROM public.intel_state_snapshots WHERE expires_at < now()"));
  });
});

// ── The admissibility policy: 2174's WHERE clause ─────────────────────────────
//
// This function creates ACTIVE claims with no human in the loop. Each clause
// below is a separate reason an observation may NOT be promoted; every expected
// literal is derived from the TypeScript that owns the same rule, so the two
// cannot drift apart in silence.

describe("system_promote_admissible_intel_claims — the autonomous promotion policy", () => {
  const body = () => flat(latestFunctionBody("system_promote_admissible_intel_claims").body);

  it("promotes ONLY on currently-valid consent (enabled AND not withdrawn)", () => {
    const f = body();
    assert.ok(f.includes("public.intel_contribution_consent"), "no consent join at all");
    assert.ok(f.includes("c.enabled = true"), "a disabled consent row must not promote");
    assert.ok(f.includes("c.withdrawn_at IS NULL"), "a WITHDRAWN contributor must stop promoting");
  });

  it("uses exactly the pilot-claimable moderation whitelist TypeScript enforces", () => {
    const f = body();
    const m = f.match(/o\.moderation_state IN \(([^)]*)\)/);
    assert.ok(m, "no moderation gate on the promotion select");
    const inSql = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
    // Sanity FIRST, so the assertion below cannot be vacuous: the states the
    // gate must EXCLUDE are themselves DERIVED (the full enum minus the pilot
    // whitelist), so a new moderation state is covered the day it is added.
    const excluded = (MODERATION_STATES as readonly string[]).filter(
      (s) => !(PILOT_CLAIMABLE_MODERATION_STATES as readonly string[]).includes(s),
    );
    assert.ok(excluded.length > 0, "every moderation state is claimable — this test would be vacuous");
    for (const blocked of excluded) {
      assert.ok(!inSql.includes(blocked), `${blocked} content must never back an auto-promoted claim`);
    }
    // DERIVED, never typed out: if the whitelist grows, 2174 must grow with it.
    assert.deepEqual(inSql, [...PILOT_CLAIMABLE_MODERATION_STATES].sort());
  });

  it("promotes only FRESH observations (expired evidence never becomes a live claim)", () => {
    const f = body();
    assert.ok(f.includes("o.expires_at IS NOT NULL"), "a null expiry must not count as fresh");
    assert.ok(f.includes("o.expires_at > p_now"), "an expired observation must not promote");
  });

  it("excludes every aggregate-only claim type — a cohort claim is never minted from one user", () => {
    const f = body();
    const aggregateOnly = CLAIM_TYPES.map((c) => c.claimType).filter((t) => mustAggregate(t));
    assert.ok(aggregateOnly.length > 0, "mustAggregate covers nothing — this test would be vacuous");
    for (const t of aggregateOnly) {
      assert.ok(
        f.includes(`o.claim_type <> '${t}'`),
        `${t} is aggregate-only in TypeScript (mustAggregate) but 2174 would auto-promote a single-user row for it`,
      );
    }
  });

  it("is idempotent: NOT EXISTS anchor guard AND ON CONFLICT DO NOTHING", () => {
    const f = body();
    assert.ok(/NOT EXISTS \( SELECT 1 FROM public\.intel_claims/.test(f), "no anchor guard");
    assert.ok(f.includes("a.status IN ('active', 'conflicting')"), "the anchor guard must look at LIVE claims");
    assert.ok(f.includes("ON CONFLICT"), "a concurrent run must not duplicate the anchor");
    assert.ok(f.includes("DO NOTHING"), "a conflict must not overwrite an existing live claim");
  });

  it("records its own provenance as 'system', never as an admin approval", () => {
    const f = body();
    assert.ok(f.includes("promotion_source"), "promotion must be attributable");
    assert.ok(f.includes("'system'"), "a system promotion must not masquerade as an admin one");
    assert.ok(!f.includes("'admin'"), "this path may never write the admin provenance");
  });

  it("never touches the downstream serving gates", () => {
    const f = body();
    // Promotion means "may ENTER aggregation", not "is live". If this function
    // ever wrote privacy_eligible or a confidence band it would be deciding what
    // is served, which is lib/intelProjection's and lib/liveClaimRead's job.
    for (const forbidden of ["privacy_eligible", "confidence_band", "intel_state_snapshots", "intel_live_promoted_scopes"]) {
      assert.ok(!f.includes(forbidden), `promotion must not write/read ${forbidden} — that is a serving decision`);
    }
  });
});
