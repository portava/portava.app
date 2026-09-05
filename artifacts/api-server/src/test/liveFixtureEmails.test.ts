/**
 * liveFixtureEmails — the run-scoping and matching rules, proved without a
 * database.
 *
 * The live-DB suites cannot prove these themselves: they only run when
 * credentials are present, and the failure this addresses is precisely a suite
 * that reports `tests=N pass=0 fail=0` because its `before` hook died. A pure
 * test of the email rules runs in the ordinary `pnpm test` tier and executes
 * whatever the database is doing.
 *
 * NO Supabase credential env var is named here, deliberately — see
 * scripts/check-guard-coverage.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURE_RUN_ID, fixtureEmail, matchesFixtureEmail } from "./liveFixtureUsers.js";

const BASE = "verif_guard_test_attacker@example.com";

describe("fixtureEmail — run-scoped fixture addresses", () => {
  it("keeps the fixture prefix and domain, and adds this run's id", () => {
    const scoped = fixtureEmail(BASE);
    assert.ok(scoped.startsWith("verif_guard_test_attacker+r"), scoped);
    assert.ok(scoped.endsWith("@example.com"), scoped);
    assert.ok(scoped.includes(FIXTURE_RUN_ID), `run id must appear in ${scoped}`);
    assert.notEqual(scoped, BASE, "a run-scoped address must differ from the base — that is the point");
  });

  it("is stable within a process, so setup, sign-in and teardown agree", () => {
    assert.equal(fixtureEmail(BASE), fixtureEmail(BASE));
  });

  it("is idempotent — wrapping twice does not double-suffix", () => {
    const once = fixtureEmail(BASE);
    assert.equal(fixtureEmail(once), once);
  });

  it("handles the other fixture domain", () => {
    const scoped = fixtureEmail("memlife_live_a@portava-test.invalid");
    assert.ok(scoped.startsWith("memlife_live_a+r"), scoped);
    assert.ok(scoped.endsWith("@portava-test.invalid"), scoped);
  });

  it("refuses a value that is not an address rather than inventing one", () => {
    assert.throws(() => fixtureEmail("not-an-email"), /not an email address/);
  });
});

describe("matchesFixtureEmail — what a purge is allowed to delete", () => {
  it("matches the un-scoped legacy address", () => {
    assert.ok(matchesFixtureEmail(BASE, BASE));
  });

  it("matches THIS run's scoped address", () => {
    assert.ok(matchesFixtureEmail(fixtureEmail(BASE), BASE));
  });

  it("matches a STRANDED address from some other run — the leftovers to sweep", () => {
    assert.ok(matchesFixtureEmail("verif_guard_test_attacker+rdeadbeef01@example.com", BASE));
  });

  it("is case-insensitive, because GoTrue lower-cases what it stores", () => {
    assert.ok(matchesFixtureEmail("VERIF_GUARD_TEST_ATTACKER@EXAMPLE.COM", BASE));
  });

  it("does NOT match a different local part that merely shares the prefix", () => {
    // The bug this forbids: a sweep that deleted anything starting with the
    // suite prefix would take another suite's fixtures with it.
    assert.equal(matchesFixtureEmail("verif_guard_test_attacker_two@example.com", BASE), false);
    assert.equal(matchesFixtureEmail("verif_guard_test_victim@example.com", BASE), false);
  });

  it("does NOT match the same local part at a different domain", () => {
    assert.equal(matchesFixtureEmail("verif_guard_test_attacker@gmail.com", BASE), false);
    assert.equal(matchesFixtureEmail("verif_guard_test_attacker+r1@gmail.com", BASE), false);
  });

  it("does NOT match a real-looking account", () => {
    assert.equal(matchesFixtureEmail("portava@internal.portava.app", BASE), false);
    assert.equal(matchesFixtureEmail("", BASE), false);
  });
});

/**
 * ── THE STRUCTURAL GUARD (2026-09-05) ───────────────────────────────────────
 *
 * The tests above prove `fixtureEmail` works. Nothing proved the live-DB suites
 * USE it — and two of them did not.
 *
 * memoryLifecycleLive and memoryProjectionLifecycleLive were left on stable
 * reuse-by-email addresses (`memlife_live_a@portava-test.invalid`) on the
 * reasoning that `ensureUser` reuses by email. When two live-DB jobs reached the
 * shared CI project at once, both resolved that address to the SAME auth user:
 * each run's teardown deleted the other's user mid-projection
 * (`memory_events violates foreign key constraint "memory_events_user_fk"`) and
 * each run's tombstone step killed the other's live control account. Five tests
 * across the two suites went red while the code under test was correct.
 *
 * A run-scoped address is not an optimisation, it is the property that makes a
 * suite safe on a shared mutable database. So this asserts it structurally, over
 * the suite list the WORKFLOW actually runs rather than a list copied by hand —
 * a suite added to CI and not to this list would otherwise be unguarded.
 *
 * The rule is per-ADDRESS, not per-file. "This file calls fixtureEmail somewhere"
 * was the first version and it was too weak to be worth having: reverting ONE of
 * memoryLifecycleLive's four addresses left the other three wrapped, so the file
 * still called the helper and the guard stayed green over a real regression.
 * Every fixture-domain literal must itself be the argument to fixtureEmail().
 *
 * As of this commit that holds for all 26 live suites with no exemptions, so
 * there is no allowlist to rot. A suite with no fixture addresses at all
 * (rlsPolicyShapeLive inspects pg_policy and touches no account) is exempt by
 * construction: it contributes no literals to scan.
 */

/**
 * Strip comments before scanning.
 *
 * The first version of this guard did not, and was mutation-proven WORTHLESS by
 * that omission: reverting memoryProjectionLifecycleLive to a stable address
 * left the explanatory comment above it — which contains the text
 * "fixtureEmail()" — and the guard stayed green over the very defect it was
 * written to catch. A guard that a comment can satisfy asserts nothing about
 * code.
 *
 * Line comments and block comments only; that is enough to make prose
 * inadmissible, which is the property under test.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * A string/template literal ending in one of the two reserved fixture domains,
 * capturing whether `fixtureEmail(` immediately precedes it.
 *
 * Both domains are non-routable by standard (`example.com` is RFC 2606,
 * `.invalid` is RFC 6761), which is why they are the fixture domains and why
 * matching on them cannot catch a real address.
 */
const FIXTURE_ADDRESS_LITERAL =
  /(fixtureEmail\(\s*)?(["'`])((?:[^"'`\\]|\\.)*?@(?:example\.com|portava-test\.invalid))\2/g;

/** Walk up to the repo root, identified by the live-DB workflow this guard reads. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".github", "workflows", "live-db.yml"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  throw new Error("could not locate the repo root (no .github/workflows/live-db.yml above this file)");
}

/** Every suite live-db.yml runs, resolved to its test file via package.json. */
function liveSuiteFiles(): Array<{ script: string; file: string; source: string }> {
  const root = repoRoot();
  const workflow = readFileSync(join(root, ".github", "workflows", "live-db.yml"), "utf8");
  const scripts: Record<string, string> =
    JSON.parse(readFileSync(join(root, "artifacts", "api-server", "package.json"), "utf8")).scripts ?? {};

  const out: Array<{ script: string; file: string; source: string }> = [];
  const invocation = /run-live-suite\.sh\s+\S+\s+\S+\s+\S+\s+(\S+)/g;
  for (const [, scriptName] of workflow.matchAll(invocation)) {
    const command = scripts[scriptName];
    assert.ok(command, `live-db.yml runs '${scriptName}', which artifacts/api-server/package.json does not define`);
    const file = command.match(/src\/test\/\S+\.test\.ts/)?.[0];
    assert.ok(file, `could not resolve a test file from script '${scriptName}': ${command}`);
    const abs = join(root, "artifacts", "api-server", file);
    assert.ok(existsSync(abs), `live suite '${scriptName}' points at a missing file: ${file}`);
    out.push({ script: scriptName, file, source: stripComments(readFileSync(abs, "utf8")) });
  }
  return out;
}

describe("every live-DB suite that creates fixture users must run-scope them", () => {
  it("finds the live-DB suite list (a silently empty scan would assert nothing)", () => {
    // The bug this forbids: the workflow's invocation shape changes, the regex
    // matches nothing, and this whole guard passes over zero files.
    assert.ok(liveSuiteFiles().length >= 20, "expected the live-DB workflow to run at least 20 suites");
  });

  /** The detector's own behaviour, so the guard is not trusted on faith. */
  const unwrapped = (src: string): string[] =>
    [...stripComments(src).matchAll(FIXTURE_ADDRESS_LITERAL)].filter((m) => !m[1]).map((m) => m[3]);

  it("flags a bare fixture address", () => {
    assert.deepEqual(unwrapped('const A = "memlife_live_a@portava-test.invalid";'), [
      "memlife_live_a@portava-test.invalid",
    ]);
    assert.deepEqual(unwrapped('const A = "x@example.com";'), ["x@example.com"]);
  });

  it("accepts one that is wrapped, including the template-literal form the suites use", () => {
    assert.deepEqual(unwrapped('const A = fixtureEmail("memlife_live_a@portava-test.invalid");'), []);
    assert.deepEqual(unwrapped("const A = fixtureEmail(`${TAG}a@portava-test.invalid`);"), []);
  });

  it("flags a PARTIAL revert — the mutation that slipped past the per-file version", () => {
    assert.deepEqual(
      unwrapped('const A = "t_a@example.com";\nconst B = fixtureEmail("t_b@example.com");'),
      ["t_a@example.com"],
    );
  });

  it("does not accept a mention in PROSE as a call — the omission that made v1 vacuous", () => {
    assert.deepEqual(unwrapped('/** wrap in fixtureEmail() */\nconst A = "t@example.com";'), [
      "t@example.com",
    ]);
    assert.deepEqual(unwrapped('// fixtureEmail("t@example.com")'), []);
  });

  it("ignores addresses at domains that are not fixture domains", () => {
    assert.deepEqual(unwrapped('const A = "someone@gmail.com";'), []);
  });

  it("every fixture address in a live suite is itself an argument to fixtureEmail()", () => {
    const offenders: string[] = [];

    for (const { script, file, source } of liveSuiteFiles()) {
      for (const match of source.matchAll(FIXTURE_ADDRESS_LITERAL)) {
        const [, wrapped, , address] = match;
        if (!wrapped) offenders.push(`${script} (${file}): ${address}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "these live-DB suites create fixture accounts at addresses that are NOT run-scoped. Two live-DB jobs " +
        "against the shared CI project will resolve them to the same auth user and delete each other's " +
        "fixtures mid-test. Wrap the addresses in fixtureEmail() from ./liveFixtureUsers.js — it is stable " +
        "within a process, so ensureUser's reuse-by-email behaviour is unchanged; only concurrent runs differ.",
    );
  });
});
