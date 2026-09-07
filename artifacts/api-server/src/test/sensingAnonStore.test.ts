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
    join("lib", "sensingPresenceState.ts"),
    'the §19 PresenceObservation built from "cohort/coverage aggregation": takes the aggregate\'s ' +
      "decision (a type import) and carries truth class / confidence / freshness / coverage. " +
      "Reads no store, publishes nothing, names no contributor.",
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
    join("lib", "envValidation.ts"),
    "names lib/sensingAnonStore in the comment recording why SENSING_CONTRIBUTOR_PEPPER is " +
      "OPTIONAL rather than boot-required. It imports nothing and reads no store.",
  ],
  [
    join("scripts", "checkProductionDrift.ts"),
    "the CI-vs-production drift registry classifies sensing_anon_contributions as a known gap. " +
      "That is data ABOUT the table, not a caller of it.",
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

  it("no route touches the store — a transport is an owner decision, not an implementation detail", () => {
    const routes = walk(join(SRC, "routes"));
    assert.ok(routes.length > 100, "premise: the route tree was found");
    const offenders = routes.filter((f) => {
      const text = readFileSync(f, "utf8");
      return /sensingAnonStore|sensingCoverageAggregate|sensingAnonService/.test(text) || text.includes(TABLE);
    });
    assert.deepEqual(offenders, [], "an HTTP surface for the anonymous sensing store needs an owner decision first");
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

  it("no feature flag was invented for this store", () => {
    // 2315 seeds none, and seeding one is an owner decision (sensing-input-gap
    // §3.2). The TTL sweep is gated on the table existing instead.
    assert.doesNotMatch(CODE, /feature_flags/i);
    for (const f of PERMITTED_REFERRERS.keys()) {
      const text = readFileSync(join(SRC, f), "utf8");
      assert.ok(!/isFlagEnabled|feature_flags/.test(text), `${f} reads a feature flag that nothing seeds`);
    }
  });

  it("the contract module both reads and writes the table, so it is not a writerless read", () => {
    assert.match(STORE_TS, new RegExp(`from\\(SENSING_TABLE\\)[\\s\\S]{0,80}\\.insert\\(`));
    assert.match(STORE_TS, new RegExp(`from\\(SENSING_TABLE\\)[\\s\\S]{0,200}\\.select\\(`));
  });
});
