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
