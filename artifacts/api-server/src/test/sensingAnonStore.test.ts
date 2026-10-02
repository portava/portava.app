/**
 * Structural contract of the anonymous sensing store — migration 2315 and the
 * two modules over it.
 *
 * The properties the owner ruling turns on are STRUCTURAL, so they are asserted
 * against the migration text and the module sources rather than inferred from
 * behaviour. The ruling, verbatim:
 *
 *   "A short-lived anonymous sensing contribution/aggregation store IS allowed
 *    even though intel_observations requires actor_id. It is not a second intel
 *    lifecycle. Existing intel evidence -> claims -> snapshots remains canonical.
 *    The anonymous store may only own privacy-reduced sensor contributions,
 *    rotating IDs, TTL, cohort/coverage aggregation and revocation. It must not
 *    duplicate claim/review/status/conflict/snapshot semantics and must not
 *    contain a permanent profiles/user FK."
 *
 * Behaviour — expiry, revocation, the privacy refusals, the failed-read rule —
 * is proved in src/test/sensingCoverageAggregate.test.ts.
 *
 * No database, and no Supabase credential env var is named anywhere in this file
 * (which is what keeps it out of scripts/check-guard-coverage.mjs's reachable
 * set — the same deliberate split src/test/migrationLedger.test.ts documents).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const MIGRATION = join(SRC, "migrations", "2315_sensing_anon_contributions.sql");
const SQL = readFileSync(MIGRATION, "utf8");
const STORE_TS = readFileSync(join(SRC, "lib", "sensingAnonStore.ts"), "utf8");
const AGG_TS = readFileSync(join(SRC, "lib", "sensingCoverageAggregate.ts"), "utf8");

const TABLE = "sensing_anon_contributions";

/** The SQL with comments removed, so a promise in prose can never satisfy an assertion. */
const CODE = SQL.replace(/--[^\n]*/g, "");

/**
 * CODE with single-quoted string literals blanked too. Used where the assertion
 * is about SQL STRUCTURE: the table COMMENT and the postcondition messages
 * legitimately name profiles, auth.users and the intel lifecycle in prose, and a
 * word inside a message is not a reference.
 */
const DDL = CODE.replace(/'(?:[^']|'')*'/g, "''");

/** TypeScript with comments removed, for the same reason. */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ── The ruling, clause by clause ─────────────────────────────────────────────

describe("2315 — no permanent profiles/user FK, ever", () => {
  it("the table body declares no REFERENCES at all", () => {
    assert.doesNotMatch(DDL, /REFERENCES/i, "the anonymous store references nothing");
  });

  it("names neither profiles(id) nor auth.users as a target", () => {
    assert.doesNotMatch(DDL, /public\.profiles\s*\(/i);
    assert.doesNotMatch(DDL, /auth\.users\s*\(/i);
  });

  it("declares no column that is an account or device handle", () => {
    // Extract the CREATE TABLE body and check the declared column names, so a
    // handle cannot arrive as a bare uuid with no constraint behind it.
    const start = CODE.indexOf(`CREATE TABLE IF NOT EXISTS public.${TABLE}`);
    assert.ok(start >= 0, "the table is not created");
    const body = CODE.slice(start, CODE.indexOf("CREATE INDEX", start));
    for (const forbidden of [
      "user_id", "actor_id", "profile_id", "account_id", "auth_id", "owner_id",
      "created_by", "contributor_id", "device_id", "session_id", "installation_id",
    ]) {
      assert.doesNotMatch(body, new RegExp(`(^|[^a-z_])${forbidden}\\b`, "i"), `${forbidden} is an identity`);
    }
  });

  it("a postcondition inspects pg_constraint and RAISEs on a profiles/auth.users FK", () => {
    assert.match(CODE, /FROM pg_constraint/);
    assert.match(CODE, /c\.contype\s*=\s*'f'/);
    assert.match(CODE, /rel\.relname\s*=\s*'profiles'/);
    assert.match(CODE, /rel\.relname\s*=\s*'users'/);
    assert.match(CODE, /v_user_fks\s*>\s*0[\s\S]{0,200}RAISE EXCEPTION/);
  });

  it("and a stronger postcondition RAISEs on ANY foreign key — a join out is a re-identification path", () => {
    assert.match(CODE, /v_fks\s*>\s*0[\s\S]{0,200}RAISE EXCEPTION/);
  });

  it("a postcondition RAISEs on an identity-shaped COLUMN NAME, constraint or not", () => {
    for (const forbidden of ["user_id", "actor_id", "profile_id", "account_id", "device_id"]) {
      assert.ok(CODE.includes(`'${forbidden}'`), `${forbidden} is not in the refused-name list`);
    }
    assert.match(CODE, /information_schema\.columns[\s\S]{0,400}RAISE EXCEPTION/);
  });
});

describe("2315 — does not duplicate claim/review/status/conflict/snapshot semantics", () => {
  it("declares none of the lifecycle columns", () => {
    const start = CODE.indexOf(`CREATE TABLE IF NOT EXISTS public.${TABLE}`);
    const body = CODE.slice(start, CODE.indexOf("CREATE INDEX", start));
    for (const forbidden of [
      "status", "state", "claim_type", "claim_id", "conflict", "snapshot",
      "review", "reviewer_id", "verdict", "moderation_state", "visibility",
      "confidence", "superseded_by", "promotion_source", "source_class",
    ]) {
      assert.doesNotMatch(body, new RegExp(`(^|[^a-z_])${forbidden}\\b`, "i"), `${forbidden} belongs to the intel lifecycle`);
    }
  });

  it("a postcondition RAISEs if one is ever added", () => {
    for (const forbidden of ["status", "claim_type", "conflict", "snapshot", "review", "moderation_state", "confidence"]) {
      assert.ok(CODE.includes(`'${forbidden}'`), `${forbidden} is not in the refused-column list`);
    }
  });

  it("carries no free text and no value payload — nothing to make an assertion with", () => {
    const start = CODE.indexOf(`CREATE TABLE IF NOT EXISTS public.${TABLE}`);
    const body = CODE.slice(start, CODE.indexOf("CREATE INDEX", start));
    assert.doesNotMatch(body, /\bjsonb\b/i, "a jsonb payload is how a claim value arrives");
    assert.doesNotMatch(body, /(^|[^a-z_])(reason|note|notes|comment|body)\b/i);
  });

  it("grants no UPDATE to anyone — a contribution is written once", () => {
    assert.doesNotMatch(CODE, new RegExp(`GRANT[^;]*UPDATE[^;]*ON public\\.${TABLE}`, "i"));
  });

  it("leaves the canonical lifecycle entirely alone", () => {
    for (const t of [
      "intel_observations", "intel_claims", "intel_state_snapshots",
      "intel_evidence", "intel_confirmations", "intel_claim_reviews",
    ]) {
      assert.doesNotMatch(DDL, new RegExp(`\\b${t}\\b`), `2315 must not touch ${t}`);
    }
  });
});

describe("2315 — short-lived", () => {
  it("expires_at is NOT NULL and capped by a CHECK, so a long-lived row is unrepresentable", () => {
    assert.match(CODE, /expires_at\s+timestamptz\s+NOT NULL/);
    assert.match(CODE, /CHECK \(expires_at > created_at AND expires_at <= created_at \+ interval '72 hours'\)/);
  });

  it("a postcondition proves the TTL CHECK survived", () => {
    assert.match(CODE, new RegExp(`conname = '${TABLE}_ttl_check'[\\s\\S]{0,300}RAISE EXCEPTION`));
  });

  it("the module's ceiling matches the database's", async () => {
    const { SENSING_MAX_TTL_SECONDS } = await import("../lib/sensingAnonStore.js");
    assert.equal(SENSING_MAX_TTL_SECONDS, 72 * 60 * 60);
  });

  it("a sweep exists, and takes its instant rather than reading a clock", () => {
    assert.match(CODE, /CREATE OR REPLACE FUNCTION public\.purge_expired_sensing_contributions\(p_now timestamptz\)/);
    assert.doesNotMatch(
      CODE.slice(CODE.indexOf("purge_expired_sensing_contributions"), CODE.indexOf("revoke_sensing_contributions")),
      /\bnow\(\)/,
      "a sweep that reads its own clock is not deterministically testable",
    );
  });
});

describe("2315 — rotating ids and identity-free revocation", () => {
  it("stores a rotating token bound to an epoch, not an id", () => {
    assert.match(CODE, /contributor_token text\s+NOT NULL/);
    assert.match(CODE, /rotation_epoch\s+bigint\s+NOT NULL/);
    // text, not uuid: a uuid column is how an account id gets in later.
    assert.doesNotMatch(CODE, /contributor_token\s+uuid/i);
  });

  it("the revocation function takes an epoch and a token — and nothing that could be an identity", () => {
    const sig = CODE.match(/CREATE OR REPLACE FUNCTION public\.revoke_sensing_contributions\(([\s\S]*?)\)\s*RETURNS/);
    assert.ok(sig, "the revocation function is missing");
    const params = sig![1];
    assert.match(params, /p_rotation_epoch bigint/);
    assert.match(params, /p_contributor_token text/);
    for (const forbidden of ["user", "actor", "profile", "account", "auth", "device", "session"]) {
      assert.ok(!params.toLowerCase().includes(forbidden), `revocation takes a ${forbidden}`);
    }
  });

  it("the TypeScript revocation input has exactly two fields, neither an identity", () => {
    const iface = stripTsComments(STORE_TS).match(/export interface SensingRevocation \{([\s\S]*?)\n\}/);
    assert.ok(iface, "SensingRevocation is missing");
    const fields = iface![1].match(/^\s*(\w+)/gm)?.map((s) => s.trim()) ?? [];
    assert.deepEqual(fields.sort(), ["epochSecret", "rotationEpoch"]);
  });

  it("the contributor token is peppered server-side and has no constant fallback", () => {
    assert.match(STORE_TS, /SENSING_CONTRIBUTOR_PEPPER/);
    assert.match(STORE_TS, /throw new Error\([\s\S]{0,200}no fallback/);
  });

  it("the device secret is never part of a stored row or a write payload", () => {
    const code = stripTsComments(STORE_TS);
    const rowIface = code.match(/export interface SensingContributionRow \{([\s\S]*?)\n\}/);
    const inputIface = code.match(/export interface SensingContributionInput \{([\s\S]*?)\n\}/);
    assert.ok(rowIface && inputIface);
    for (const shape of [rowIface![1], inputIface![1]]) {
      assert.ok(!/deviceSecret/.test(shape), "a device secret must never be transmitted or stored");
      assert.ok(!/epochSecret/.test(shape), "an epoch secret is revealed only to revoke");
    }
  });
});

describe("2315 — RLS posture, service_role only (2311's posture)", () => {
  it("RLS is enabled", () => {
    assert.match(CODE, new RegExp(`ALTER TABLE public\\.${TABLE} ENABLE ROW LEVEL SECURITY`));
  });

  it("grants are revoked from PUBLIC, anon and authenticated first", () => {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      assert.match(CODE, new RegExp(`REVOKE ALL ON public\\.${TABLE} FROM ${role}`));
    }
  });

  it("service_role is the only grantee, and no anon/authenticated policy exists", () => {
    assert.match(CODE, new RegExp(`GRANT SELECT, INSERT, DELETE ON public\\.${TABLE} TO service_role`));
    assert.doesNotMatch(CODE, new RegExp(`GRANT[^;]*ON public\\.${TABLE} TO (anon|authenticated)`));
    assert.doesNotMatch(CODE, new RegExp(`CREATE POLICY[^;]*ON public\\.${TABLE}[\\s\\S]{0,120}TO (anon|authenticated)`));
    assert.match(CODE, new RegExp(`CREATE POLICY ${TABLE}_service ON public\\.${TABLE}[\\s\\S]{0,120}TO service_role`));
  });

  it("a postcondition asserts the anon/authenticated policy count is zero", () => {
    assert.match(CODE, /FROM pg_policies[\s\S]{0,300}'anon' = ANY\(roles\) OR 'authenticated' = ANY\(roles\)/);
    assert.match(CODE, /v_policies\s*>\s*0[\s\S]{0,300}RAISE EXCEPTION/);
  });

  it("a postcondition asserts RLS is actually on", () => {
    assert.match(CODE, /relrowsecurity[\s\S]{0,300}RAISE EXCEPTION/);
  });

  it("both functions are service_role only", () => {
    for (const fn of ["purge_expired_sensing_contributions\\(timestamptz\\)", "revoke_sensing_contributions\\(bigint, text\\)"]) {
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        assert.match(CODE, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM ${role}`));
      }
      assert.match(CODE, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO service_role`));
    }
  });
});

describe("2315 — migration hygiene", () => {
  it("is additive and idempotent", () => {
    assert.match(CODE, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${TABLE}`));
    assert.equal((CODE.match(/CREATE TABLE/g) ?? []).length, 1, "exactly one table");
    for (const m of CODE.match(/CREATE INDEX[^;]*/g) ?? []) {
      assert.match(m, /CREATE INDEX IF NOT EXISTS/);
    }
    assert.match(CODE, new RegExp(`DROP POLICY IF EXISTS ${TABLE}_service`));
    assert.doesNotMatch(CODE, /\bALTER TABLE public\.(?!sensing_anon_contributions)/, "no existing table is altered");
    assert.doesNotMatch(CODE, /\bDROP TABLE\b/i);
  });

  it("writes no row and creates no feature flag", () => {
    assert.doesNotMatch(CODE, /INSERT\s+INTO/i, "an inert store ships empty");
    assert.doesNotMatch(CODE, /feature_flags/i);
  });

  it("does NOT self-register in the ledger — since 2258 that is the apply tooling's job", () => {
    assert.doesNotMatch(CODE, /schema_migration_ledger/i);
  });

  it("is wrapped in exactly one transaction, with nothing before or after it", () => {
    const lines = SQL.split("\n");
    assert.equal(lines.filter((l) => l.trim() === "BEGIN;").length, 1);
    assert.equal(lines.filter((l) => l.trim() === "COMMIT;").length, 1);
    const before = SQL.slice(0, SQL.indexOf("\nBEGIN;"));
    assert.equal(before.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).length, 0);
    const after = SQL.slice(SQL.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);
    assert.equal(after.trim(), "");
    assert.doesNotMatch(SQL, /\bCONCURRENTLY\b/i);
  });

  it("every RAISE in the postcondition block is guarded by a condition", () => {
    // The same rule src/test/migrationDeployability.test.ts enforces repo-wide,
    // restated here so a regression names THIS file.
    const doBlocks = SQL.match(/^DO \$\$[\s\S]*?\$\$;/gm) ?? [];
    assert.ok(doBlocks.length > 0, "there are no postconditions");
    for (const block of doBlocks) {
      const blockLines = block.split("\n");
      blockLines.forEach((line, i) => {
        if (!/^\s*RAISE\s+EXCEPTION/i.test(line)) return;
        const guarded = blockLines
          .slice(Math.max(0, i - 8), i)
          .some((l) => /\bTHEN\b|\bIF\b|\bELSE\b|\bELSIF\b|\bLOOP\b/i.test(l));
        assert.ok(guarded, `unconditional RAISE at line ${i}: ${line.trim()}`);
      });
    }
  });

  it("claims lane 2315 alone", () => {
    const files = readdirSync(join(SRC, "migrations")).filter((f) => f.endsWith(".sql"));
    assert.ok(files.length > 100, "premise: the migration directory was found");
    assert.deepEqual(files.filter((f) => f.startsWith("2315")), ["2315_sensing_anon_contributions.sql"]);
  });
});

// ── The aggregation routes through the SHARED gate, and owns no threshold ────

describe("aggregation — routes through the real privacy gate", () => {
  it("imports evaluatePrivacy and the shared threshold, and calls the gate", () => {
    assert.match(AGG_TS, /import \{[\s\S]*?evaluatePrivacy[\s\S]*?\} from "\.\/privacyGate\.js"/);
    assert.match(AGG_TS, /PRIVACY_THRESHOLD_V1[\s\S]*?from "\.\/intelContracts\.js"/);
    assert.ok((AGG_TS.match(/evaluatePrivacy\(/g) ?? []).length >= 2, "the gate must actually be called");
  });

  it("contains no second copy of the threshold arithmetic", () => {
    const code = stripTsComments(AGG_TS);
    assert.ok(!code.includes("meetsKAnonymity"), "k-anonymity must not be re-implemented");
    assert.ok(!code.includes("kAnonymity"), "the gate is the single decision point");
    for (const literal of ["15", "0.2", "minUniqueActors", "minIndependentGroups", "maxSingleGroupShare"]) {
      assert.ok(!code.includes(literal), `the threshold value "${literal}" is hard-coded here`);
    }
  });

  it("never reads the transport's count — reportedCount lives on the failure branch only", () => {
    const code = stripTsComments(AGG_TS);
    assert.ok(!code.includes("reportedCount"), "the aggregation must derive every number from rows it holds");
    const store = stripTsComments(STORE_TS);
    const okBranch = store.match(/\{ ok: true; complete: boolean; rows: readonly SensingContributionRow\[\] \}/);
    assert.ok(okBranch, "the success branch must not carry a count at all");
  });

  it("refuses a failed or incomplete read with reasons distinct from the gate's", () => {
    assert.match(AGG_TS, /"read_failed"/);
    assert.match(AGG_TS, /"read_incomplete"/);
  });
});

// ── Reachability: who is allowed to touch this store ─────────────────────────
//
// THIS SECTION USED TO ASSERT THE STORE WAS WIRED INTO NOTHING, and it should be
// read knowing that. When 2315 landed, the store had no caller anywhere and these
// tests asserted the importer list and the table-name list were both EMPTY. That
// was a deliberate tripwire: the first live import would turn CI red, so wiring
// the store could not happen quietly.
//
// The tripwire fired, as designed, when the four callers the owner ruling
// already permits were built. It is NOT deleted here — deleting it is what it
// existed to prevent. It is tightened into an ALLOWLIST, so the property it
// enforced survives in a stronger form:
//
//   * an UNLISTED referrer is still red, exactly as before;
//   * a listed file that no longer references anything is ALSO red, so the list
//     cannot rot into a blanket permission for files that have moved on;
//   * and a new negative is added below that the empty-list version could not
//     express: no route may reference this store, ever, because the transport is
//     the step the gap analysis classifies as needing an owner decision
//     (docs/architecture/sensing-input-gap.md §3.2).
//
// Each entry carries the clause of the owner ruling that permits it, verbatim
// from the enumeration: "privacy-reduced sensor contributions, rotating IDs,
// TTL, cohort/coverage aggregation and revocation". A referrer that cannot be
// justified by one of those five words does not belong on this list, and adding
// it here is the visible act that makes that claim in a diff.
const PERMITTED_REFERRERS = new Map<string, string>([
  [
    join("lib", "sensingAnonService.ts"),
    'the service-role bindings for "privacy-reduced sensor contributions", ' +
      '"cohort/coverage aggregation" and "revocation". No route, no flag, no publisher.',
  ],
  [
    join("lib", "sensingRetentionScheduler.ts"),
    'the "TTL" sweep: calls purge_expired_sensing_contributions, and only where the table exists.',
  ],
  [
    join("lib", "sensingContributionPolicy.ts"),
    'the S1 privacy contract over "privacy-reduced sensor contributions", "rotating IDs", "TTL" and ' +
      '"revocation": purpose scopes, precision, retention, credential validity, composed from the ' +
      "store's own constants. Pure admission; no issuer, no route, no flag, no publisher.",
  ],
  [
    join("lib", "sensingContributionSession.ts"),
    'the issued half of "rotating IDs" — a short-lived budgeted credential (2480, UNAPPLIED) whose ' +
      "hash is derived under the store's pepper. Pure issuance/validation; no route, no flag, no " +
      "publisher. Nothing here can run until the owner decides SENSING_AUTH_POSTURE.",
  ],
  [
    join("lib", "sensingRevocationLineage.ts"),
    'the §18.4 lineage definition for "revocation": models a revocation in memory against the ' +
      "store's own predicate and the aggregate, proving a published aggregate carries nothing to " +
      "revoke. Pure; no route, no flag, no publisher.",
  ],
  [
    join("lib", "sensingWindowAggregate.ts"),
    'the per-WINDOW half of "cohort/coverage aggregation" (census-sensing S42/S52): joins a run of ' +
      "adjacent cohort reads into arrival/departure rates, coverage and dwell, and hands them to " +
      "lib/vibeInference. It holds contributor tokens only to DIFFERENCE them between adjacent " +
      "buckets and returns numbers — no token, set or per-person field appears on its result, which " +
      "is asserted on the serialised value. A bucket the privacy gate refused contributes nothing, " +
      "so a rate is never computed over a sub-k cohort. Pure; no route, no flag, no publisher.",
  ],
  [
    join("lib", "sensingDifferencingGate.ts"),
    'the anti-differencing rule over "cohort/coverage aggregation" outputs (a type import): a ' +
      "re-publication must move by a whole independent party or not at all. Pure; keeps no token.",
  ],
  [
    join("lib", "sensingPresenceState.ts"),
    'the §19 PresenceObservation built from "cohort/coverage aggregation": takes the aggregate\'s ' +
      "decision (a type import) and carries truth class / confidence / freshness / coverage. " +
      "Reads no store, publishes nothing, names no contributor.",
  ],
  [
    // THE ENTRY THE OLD TRIPWIRE EXISTED TO MAKE IMPOSSIBLE. See the block
    // comment above `describe("exactly one writer ...")` below for why it is
    // here and what retired the assertion that forbade it.
    join("routes", "sensingIngest.ts"),
    'the ONE transport for "privacy-reduced sensor contributions": POST ' +
      "/v1/sensing/contributions, authenticated by the opaque contribution credential (2480) and by " +
      "nothing else. No requireUser, no optionalUser, no actor_id, no location_snapshots. It walks " +
      "the existing eligibility/session/budget ladder rather than around it, and it reads no " +
      "aggregate — surface and share are scopes SENSING_ANON_POLICY_V1 does not grant.",
  ],
  [
    join("routes", "sensingSession.ts"),
    "the ELIGIBILITY route (§3) that issues the opaque credential the ingest authenticates. It WRITES " +
      "2480's session table, never this store: from the store modules it takes exactly the pure " +
      "rotation-epoch function and the pepper posture (so it refuses when the ingest would), which the " +
      "route-level case below pins import by import. It names neither this table nor any writer.",
  ],
  [
    // ADDED 2026-09-26 (census-sensing §26.3): the PUBLISHER, §21.4's blocker #2.
    join("lib", "sensingPublicationScheduler.ts"),
    'the one production reader of "cohort/coverage aggregation" that RECORDS: on its own clock, per ' +
      "live cohort, readSensingCohort → aggregateSensingCohort → publishThroughDifferencingGate into " +
      "3110's publication store. It refuses FIRST on the `surface` purpose scope (ungranted; checked " +
      "before it obtains a client), then on sensing_publication_enabled (3313, seeded FALSE), then " +
      "on the schema. A cohort the k-gate withholds never reaches the gate or the store; counts only " +
      "in logs. Not a transport: nothing enters the store through it.",
  ],
  [
    // ADDED 2026-09-26 (census-sensing §26.3): the CONSUMER now imports the store's PURE key
    // functions, and nothing else from it.
    join("compass", "CompassSensingPresenceProducer.ts"),
    "decision #9's consumer. It imports sensingCohortKey / sensingTimeBucket / SENSING_REDUCTION_VERSION " +
      "— pure functions of (zone, bucket, version), shared with the writer so the turn's zone refs " +
      "name the KEY the publisher recorded — and reads ONLY the publication store (3110), never the " +
      "contribution table; sensingPublicationScheduler.test.ts asserts the contribution store is " +
      "untouched by it. Its first gate is the `surface` scope, which SENSING_ANON_POLICY_V1 does not grant.",
  ],
]);

/**
 * Files that NAME the store without calling it. Kept separate from the caller
 * allowlist on purpose — a prose or data mention is a different fact from a
 * call, and collapsing the two would let a real caller hide behind "it is only
 * mentioned". Every entry here is asserted below to contain no import.
 *
 * checkProductionDrift.ts is worth reading twice: it was added to this branch
 * AFTER 2315, and it names the table. So the original zero-namers assertion was
 * already false here before any caller existed — the tripwire had drifted from
 * "nothing calls this" to "nothing mentions this", which is not the property
 * anybody wanted to enforce.
 */
const PERMITTED_MENTIONS = new Map<string, string>([
  [
    join("lib", "sensingAuthPosture.ts"),
    "names the store while explaining why the FK on intel_observations is not the cap — the posture " +
      "is. It is the owner's undecided switch (SENSING_AUTH_POSTURE) and imports nothing from the store.",
  ],
  [
    join("lib", "envValidation.ts"),
    "names lib/sensingAnonStore in the comment recording why SENSING_CONTRIBUTOR_PEPPER is " +
      "OPTIONAL rather than boot-required. It imports nothing and reads no store.",
  ],
  [
    join("scripts", "checkProductionDrift.ts"),
    "the CI-vs-production drift registry classifies sensing_anon_contributions as a known gap. " +
      "That is data ABOUT the table, not a caller of it.",
  ],
  [
    join("scripts", "checkCensusFreshness.ts"),
    "CENSUS_SCOPE names lib/sensingAnonStore.ts as a PATH that ages census-sensing.md — the file is " +
      "listed so that editing it marks that census stale. A path in a staleness registry is data " +
      "about the file, not a reader of the store; this script imports nothing and touches no table. " +
      "It is there for a reason the census itself records: census-sensing's CORRECTION HEADER says " +
      "the document was already stale when committed because this exact store landed two minutes " +
      "earlier, so it is the one path whose omission would have hidden the defect.",
  ],
]);

describe("the store is reachable only from the callers the ruling names", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full);
    }
    return out;
  }

  /**
   * Every non-test, non-self file under src/ that mentions either module OR the
   * table by name. One scan, deliberately: an import and a bare table name are
   * two ways to reach the same store, and the original tripwire ran them as two
   * lists, which is how one of them silently acquired an entry.
   */
  function mentioners(): string[] {
    return walk(SRC)
      .filter((f) => {
        if (f.includes(`${join("src", "test")}`)) return false;
        if (f.includes(`${join("src", "migrations")}`)) return false;
        if (f.endsWith("sensingAnonStore.ts") || f.endsWith("sensingCoverageAggregate.ts")) return false;
        const text = readFileSync(f, "utf8");
        return /sensingAnonStore|sensingCoverageAggregate/.test(text) || text.includes(TABLE);
      })
      .map((f) => f.slice(SRC.length + 1));
  }

  const IMPORT_RE = /import[\s\S]{0,400}?from\s+"\.[^"]*sensing(AnonStore|CoverageAggregate|AnonService)\.js"/;

  it("both allowlists are non-empty and every entry gives a reason", () => {
    // Vacuity is failure: an empty allowlist would make the equality assertions
    // below pass by describing nothing.
    assert.ok(PERMITTED_REFERRERS.size > 0, "the caller allowlist describes nothing");
    assert.ok(PERMITTED_MENTIONS.size > 0, "the mention allowlist describes nothing");
    for (const [file, reason] of [...PERMITTED_REFERRERS, ...PERMITTED_MENTIONS]) {
      assert.ok(reason.trim().length > 20, `${file} is allowlisted with no reason`);
    }
  });

  it("the files that mention the store are EXACTLY the two allowlists — no more, and no fewer", () => {
    const files = walk(SRC);
    assert.ok(files.length > 200, "premise: the source tree was found");
    assert.deepEqual(
      mentioners().sort(),
      [...PERMITTED_REFERRERS.keys(), ...PERMITTED_MENTIONS.keys()].sort(),
      "an unlisted file references the anonymous sensing store, or an allowlisted one no longer does",
    );
  });

  it("the callers really call, and the mentions really only mention", () => {
    // Without this, the two lists are one list and the distinction is decoration.
    for (const f of PERMITTED_REFERRERS.keys()) {
      assert.match(readFileSync(join(SRC, f), "utf8"), IMPORT_RE, `${f} is allowlisted as a caller but imports nothing`);
    }
    for (const f of PERMITTED_MENTIONS.keys()) {
      assert.doesNotMatch(readFileSync(join(SRC, f), "utf8"), IMPORT_RE, `${f} is allowlisted as a mention but is a caller`);
    }
  });

  it("only allowlisted files name the table", () => {
    const namers = walk(SRC)
      .filter(
        (f) =>
          !f.includes(`${join("src", "test")}`) &&
          !f.includes(`${join("src", "migrations")}`) &&
          !f.endsWith("sensingAnonStore.ts"),
      )
      .filter((f) => readFileSync(f, "utf8").includes(TABLE))
      .map((f) => f.slice(SRC.length + 1));
    for (const f of namers) {
      assert.ok(
        PERMITTED_REFERRERS.has(f) || PERMITTED_MENTIONS.has(f),
        `${TABLE} is named by ${f}, which is on neither allowlist`,
      );
    }
  });

  it("no feature flag governs the STORE, and any flag a reader hangs from is seeded OFF by a migration in this tree", () => {
    // THIS TRIPWIRE FIRED ON 2026-09-26 AND WAS RE-AIMED, NOT RELAXED. It used
    // to assert that NO allowlisted caller read a flag at all, with the note
    // "2315 seeds none, and seeding one is an owner decision". The ruling it
    // cites says something narrower and more useful (sensing-input-gap §3.1,
    // the note under the table): the four items inside the ruling are "gated
    // on process, not on the ruling", and "any flag they hang from would be a
    // NEW SEEDED-OFF ROW" — the standing shape everywhere in this tree, where
    // seeding OFF is implementation and FLIPPING is the owner's act (§3.2's
    // last row; 3004's own header for decision #9). The publisher
    // (lib/sensingPublicationScheduler, census-sensing §26.3) is exactly that
    // shape: it hangs from sensing_publication_enabled, which 3313 seeds
    // FALSE and refuses to seed ON, and it checks the `surface` purpose scope
    // BEFORE it reads the flag, so the flag cannot substitute for consent.
    //
    // What this case still refuses, and must: (1) the store's own contract
    // module, its service and its TTL sweep reading ANY flag — the sweep is
    // gated on the table existing instead, so a flag can only add a way to
    // retain expired personal data; (2) a reader hanging from a flag that no
    // migration in this tree seeds — a phantom that "cannot be turned on
    // without shipping a migration first" (3004's words); (3) a seed whose
    // value is not FALSE.
    assert.doesNotMatch(CODE, /feature_flags/i);
    const FLAG_FREE = [join("lib", "sensingAnonService.ts"), join("lib", "sensingRetentionScheduler.ts")];
    for (const f of FLAG_FREE) {
      assert.ok(!/isFlagEnabled|feature_flags/.test(readFileSync(join(SRC, f), "utf8")), `${f} must not read a flag: the store's own path is gated on schema, never on a switch`);
    }
    const seededOff = new Set<string>();
    for (const m of readdirSync(join(SRC, "migrations"))) {
      if (!m.endsWith(".sql")) continue;
      const sql = readFileSync(join(SRC, "migrations", m), "utf8");
      for (const hit of sql.matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*(true|false)\b/gi)) {
        if (hit[2].toLowerCase() === "false") seededOff.add(hit[1]);
      }
    }
    for (const f of PERMITTED_REFERRERS.keys()) {
      const text = readFileSync(join(SRC, f), "utf8");
      const reads = [...text.matchAll(/isFlagEnabled\([^,]+,\s*([A-Z_]+|"[a-z0-9_]+")\s*\)/g)].map((m) => m[1]);
      for (const r of reads) {
        const name = r.startsWith('"')
          ? r.slice(1, -1)
          : (text.match(new RegExp(`export const ${r}\\s*=\\s*"([a-z0-9_]+)"`)) ?? [])[1];
        assert.ok(name, `${f} reads a flag through ${r}, which this case cannot resolve to a literal name`);
        assert.ok(seededOff.has(name), `${f} reads ${name}, which no migration in this tree seeds FALSE — a phantom flag`);
      }
    }
  });

  it("the contract module both reads and writes the table, so it is not a writerless read", () => {
    assert.match(STORE_TS, new RegExp(`from\\(SENSING_TABLE\\)[\\s\\S]{0,80}\\.insert\\(`));
    assert.match(STORE_TS, new RegExp(`from\\(SENSING_TABLE\\)[\\s\\S]{0,200}\\.select\\(`));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ASSERTION THAT USED TO LIVE HERE, WHY IT IS GONE, AND WHAT REPLACED IT
// ─────────────────────────────────────────────────────────────────────────────
//
// Until this change the suite above ended with:
//
//     it("no route touches the store — a transport is an owner decision, not an
//        implementation detail", ...)
//
// asserting that NO file under src/routes/ so much as mentions the anonymous
// sensing store. It was a tripwire on an OWNER DECISION, not on a coding
// mistake. The decision it was waiting for is named in
// docs/architecture/sensing-input-gap.md §3.2 and was encoded as
// `SENSING_AUTH_POSTURE`, which shipped `undecided` and made
// `sensingEligibility` refuse every caller with `posture_undecided`. While that
// was true, a route could admit nobody, so building one could only be an
// accident — and the tripwire made the accident loud.
//
// THAT DECISION HAS BEEN TAKEN. census-sensing.md §11 — "2026-09-16: the owner
// decided the posture" — records it: the owner chose Option B STAGED, and
// lib/sensingAuthPosture.ts:82 now reads `anonymous_capable`. The same section
// records that 2315, 2340 and 2480 were applied to production that day (visible
// independently of the prose in src/lib/capability/production-applied-migrations
// .json at version 20260916174227, and in the 2026-09-22 production schema
// capture, which lists sensing_anon_contributions with 2315's exact columns).
// §11's own list of what still blocks Sensing then puts this first:
//
//     "No ingest route. Eligibility returning `true` admits nobody while
//      nothing calls it."
//
// So the assertion was retired BY THAT DECISION, and by nothing else. It is not
// deleted to get a build green: deleting it is what it existed to prevent, and
// an absence would let a SECOND transport appear silently, which is a strictly
// worse state than the one it guarded.
//
// WHAT REPLACES IT IS A STRONGER PROPERTY, NOT A WEAKER ONE. "No route" was a
// count of zero. This is a count of exactly ONE, plus everything that makes
// that one route the thing the decision actually authorised:
//
//   * exactly one file under src/routes/ reaches the store, and it is the
//     registered ingest route — a second one is red, and so is zero, which
//     would mean the writer was deleted or renamed without this list moving;
//   * it is reached ONLY through the opaque credential: no requireUser, no
//     optionalUser, no actor_id, no location_snapshots, no profiles read;
//   * it is MOUNTED in routes/index.ts, because a route that is not registered
//     is not a writer, it is a file;
//   * it fails closed on SENSING_CONTRIBUTOR_PEPPER by name, with no fallback;
//   * it walks the existing session/budget ladder instead of a second copy of
//     it, and it returns no aggregate — `surface` and `share` are scopes
//     SENSING_ANON_POLICY_V1 does not grant.
// ─────────────────────────────────────────────────────────────────────────────
describe("exactly one writer, reached only through the opaque credential", () => {
  function walkRoutes(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkRoutes(full, out);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full);
    }
    return out;
  }

  const WRITER = join("routes", "sensingIngest.ts");
  const ISSUER = join("routes", "sensingSession.ts");
  const WRITER_TS = readFileSync(join(SRC, WRITER), "utf8");
  const WRITER_CODE = stripTsComments(WRITER_TS);
  const INDEX_TS = readFileSync(join(SRC, "routes", "index.ts"), "utf8");

  it("exactly ONE route WRITES the store — the registered ingest; the one other route importing a store module is the issuer, taking pure helpers only", () => {
    const routes = walkRoutes(join(SRC, "routes"));
    assert.ok(routes.length > 100, "premise: the route tree was found");
    const rel = (f: string) => f.slice(SRC.length + 1);
    const reachers = routes
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return /sensingAnonStore|sensingCoverageAggregate|sensingAnonService/.test(text) || text.includes(TABLE);
      })
      .map(rel)
      .sort();
    assert.deepEqual(
      reachers,
      [ISSUER, WRITER].sort(),
      "a route outside the ingest and its issuer imports the anonymous store — a second transport is a change to what census-sensing §11 authorised",
    );
    // WRITING means naming the table or calling a writer. Only the ingest does.
    const writers = routes
      .filter((f) => {
        const code = stripTsComments(readFileSync(f, "utf8"));
        return code.includes(TABLE) || /recordAnonSensingContribution|recordSensingContribution|revokeSensingContributions|revokeAnonSensingContributions/.test(code);
      })
      .map(rel);
    assert.deepEqual(writers, [WRITER], "the anonymous sensing store must have exactly one HTTP writer");
    // And the issuer's imports from the store modules are exactly the pure helpers it needs.
    const issuer = stripTsComments(readFileSync(join(SRC, ISSUER), "utf8"));
    const taken = [...issuer.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/lib\/(?:sensingAnonStore|sensingAnonService|sensingCoverageAggregate)\.js"/g)]
      .flatMap((m) => m[1]!.split(",").map((x) => x.trim()).filter(Boolean))
      .sort();
    assert.deepEqual(taken, ["SENSING_PEPPER_ENV", "rotationEpochFor", "sensingPepperPosture"]);
  });

  it("the writer is MOUNTED — a route that is not registered is a file, not a writer", () => {
    assert.match(INDEX_TS, /import sensingIngestRouter from "\.\/sensingIngest\.js";/);
    assert.match(INDEX_TS, /router\.use\(sensingIngestRouter\);/);
  });

  it("it authenticates a CREDENTIAL, never a user session", () => {
    // The whole anonymity claim. requireUser/optionalUser would put an
    // authenticated profile on the request, and the identity would then be one
    // careless line away from the storage key — which is exactly what
    // routes/intel.ts is and what this path must not become.
    assert.doesNotMatch(WRITER_CODE, /requireUser|optionalUser|requireTripMember|requireAdmin/);
    assert.match(WRITER_CODE, /deriveSensingCredentialHash/, "the bearer is matched by its HMAC, not stored in the clear");
    assert.match(WRITER_CODE, /authorization|x-sensing-credential/i);
  });

  it("it reads and writes no actor_id, and never touches location_snapshots", () => {
    // S21's server half and S32's condition, asserted against the source rather
    // than inferred: the reduced features are accepted WITHOUT a lookup keyed on
    // an actor, and the social-location store is not consulted at all.
    assert.doesNotMatch(WRITER_CODE, /actor_id/, "an actor id on the anonymous ingest path is an identity");
    assert.doesNotMatch(WRITER_CODE, /location_snapshots/, "reading location_snapshots by actor would rejoin social location to crowd intelligence");
    assert.doesNotMatch(WRITER_CODE, /\bprofiles\b/, "the anonymous path reads no profile");
    for (const forbidden of ["user_id", "profile_id", "account_id", "device_id", "installation_id"]) {
      assert.doesNotMatch(WRITER_CODE, new RegExp(`(^|[^a-z_])${forbidden}\\b`, "i"), `${forbidden} is an identity`);
    }
  });

  it("it selects the session row BY COLUMN NAME, so a later identity column is not read by accident", () => {
    // 2481 would add `issued_to_profile_id` to the session table. It must not be
    // applied under this posture (lib/sensingAuthPosture), but a `select("*")`
    // here would read it if it ever were.
    assert.doesNotMatch(WRITER_CODE, /\.select\(\s*"\*"/);
    assert.match(WRITER_CODE, /credential_hash, policy_version, purpose_scopes/);
    assert.doesNotMatch(WRITER_CODE, /issued_to_profile_id/);
  });

  it("it fails closed on the dedicated pepper, BY NAME, with no fallback", () => {
    // SENSING_CONTRIBUTOR_PEPPER is an operator secret set in no environment
    // here. Without this the store's chain would key every contributor token on
    // SESSION_SECRET, and rotating that makes prior rows unrevokable.
    assert.match(WRITER_CODE, /sensingPepperPosture\(\)/);
    assert.match(WRITER_CODE, /SENSING_PEPPER_ENV/);
    assert.doesNotMatch(WRITER_CODE, /INTEL_GROUP_KEY_SECRET|SESSION_SECRET/, "the route must not reach around the gate to a fallback secret");
    // The refusal must come before any database work.
    const pepperAt = WRITER_CODE.indexOf("sensingPepperPosture()");
    const clientAt = WRITER_CODE.indexOf("getServiceClient()");
    assert.ok(pepperAt >= 0 && clientAt > pepperAt, "the pepper is checked before a client is built");
  });

  it("it walks the EXISTING ladder rather than a second copy of it", () => {
    assert.match(WRITER_CODE, /admitWithSensingSession/, "session validity + policy admission is the session module's");
    assert.match(WRITER_CODE, /consumeSensingSessionRpc/, "the budget is 2480's atomic SQL decrement");
    assert.match(WRITER_CODE, /recordAnonSensingContribution/, "the write is the service-role binding's");
    // No re-implemented threshold, scope vocabulary or time bound.
    assert.doesNotMatch(WRITER_CODE, /minUniqueActors|minIndependentGroups|72 \* 60 \* 60|"collect"|"aggregate"/);
  });

  it("budget is consumed only after a NON-duplicate write, so a replay costs nothing", () => {
    // 2340's replay key makes a duplicate a no-op. If the budget were spent
    // first, replaying your own contribution would drain your own budget, and an
    // honest retry is indistinguishable from a replay.
    assert.match(WRITER_CODE, /if \(!written\.duplicate\)[\s\S]{0,200}consumeSensingSessionRpc/);
  });

  it("it returns no aggregate, no count and no cohort size", () => {
    // collect / retain / aggregate are granted; infer / personalize / surface /
    // share are not. Handing a contributing device a number about its cohort
    // would be `surface`.
    assert.doesNotMatch(WRITER_CODE, /aggregateSensingCohort|assessSensingCohortCoverage|readSensingCohort|distinctActors/);
  });
});
