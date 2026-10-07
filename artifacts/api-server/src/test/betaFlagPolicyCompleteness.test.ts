/**
 * The private beta's flag policy lists every flag the migration chain leaves —
 * enforced HERE, in the api-server node:test suite that ci.yml runs on every PR.
 *
 * scripts/src/beta-flag-policy.json decides, flag by flag, what the beta database
 * holds (applied by .github/workflows/beta-config.yml, which REFUSES to write
 * when a policy flag is missing from the database). Its full test,
 * scripts/src/beta-configure.test.ts, runs only in unwired-checks.yml, which is
 * on probation and not what a merge is judged on. So a lane could merge a
 * migration that seeds or retires a flag, main would stay green, and the next
 * beta-config.yml dispatch would fail — or, worse, a flag would sit in the beta
 * database undecided (forced OFF and reported, never reviewed).
 *
 * This test runs the policy's own structural rules (flagPolicyProblems: every
 * seeded flag listed exactly once, nothing unknown listed, every ON entry with
 * evidence) against the policy's own migration scanner (seededFlagPopulation,
 * chain order, DELETEs retire), imported from scripts/src — one implementation,
 * two runners. When it goes red after a merge:
 *
 *   pnpm -C scripts beta:flag-policy-sync           # what is missing / retired
 *   pnpm -C scripts beta:flag-policy-sync --write   # adds new FALSE-seeded flags OFF, removes retired ones
 *
 * A flag a migration turns ON is refused by the tool: it needs a reviewed
 * decision in the policy and in beta-configure.test.ts POST_SNAPSHOT_SEEDED_TRUE.
 *
 * Run: node --import tsx/esm --test src/test/betaFlagPolicyCompleteness.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CORE = join(REPO_ROOT, "scripts", "src", "beta-config-core.ts");

interface PolicyEntry { flag: string; enabled: boolean; kind: string }
interface Core {
  loadFlagPolicy(): { flags: PolicyEntry[] };
  seededFlagPopulation(): Map<string, { flag: string }>;
  flagPolicyProblems(policy: unknown, population: unknown): string[];
}

describe("scripts/src/beta-flag-policy.json — complete against the migration chain on this commit", () => {
  let core: Core;
  before(async () => {
    // Imported by URL at run time: the module lives in the scripts package (one implementation, two runners).
    core = (await import(pathToFileURL(CORE).href)) as Core;
  });

  it("the scanner is not vacuous", () => {
    const population = core.seededFlagPopulation();
    assert.ok(population.size > 250, `only ${population.size} seeded flags found — the scan broke`);
    assert.ok(population.has("invite_only_beta") && population.has("disable_signups"));
  });

  it("every flag a migration leaves is decided exactly once, and nothing undecided or retired is listed", () => {
    const problems = core.flagPolicyProblems(core.loadFlagPolicy(), core.seededFlagPopulation());
    assert.deepEqual(
      problems,
      [],
      "the beta flag policy is out of step with the migrations. Run `pnpm -C scripts beta:flag-policy-sync` " +
        "(and `--write` for the safe half: new FALSE-seeded flags OFF, retired flags removed); a flag a migration " +
        "turns ON needs a reviewed entry. Then re-dispatch beta-config.yml after merge.",
    );
  });

  it("the beta stays closed and Rent-a-Buddy bookings stay shut, whatever else the policy says", () => {
    const by = new Map(core.loadFlagPolicy().flags.map((e) => [e.flag, e]));
    for (const f of ["invite_only_beta", "disable_signups", "disable_rent_buddy_booking", "disable_rab_bookings", "RENT_BUDDY_ADMIN_ONLY_MODE"]) {
      assert.equal(by.get(f)?.enabled, true, `${f} must be ON in the beta policy`);
    }
    for (const e of by.values()) {
      if (/rent_buddy|RENT_BUDDY|wall_rab|discovery_buddy/.test(e.flag) && e.kind === "CAPABILITY") {
        assert.equal(e.enabled, false, `${e.flag}: every Rent-a-Buddy capability is OFF on beta`);
      }
    }
  });
});
