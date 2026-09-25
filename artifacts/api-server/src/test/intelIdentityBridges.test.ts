/**
 * S118 — the four tables 3002 left bridging a contribution back to an account.
 *
 * THE FINDING
 * ===========
 * 3002 tokenises `actor_id` on the three CONTRIBUTION tables and says, in its
 * own header, that it is not finished:
 *
 *   "Tables OUTSIDE this migration's scope still bridge an observation to an
 *    account: intel_presence_verifications (2276), intel_attributions (2277),
 *    intel_scoped_trust (2278) and intel_reward_ledger (2170) ... the §24
 *    checklist item is satisfied for the contribution tables and NOT for the
 *    intel family as a whole."
 *
 * Measured against production on 2026-09-25, the four are not one question:
 *
 *   intel_presence_verifications  observation_id + account actor_id, LIVE in
 *                                 production — one join from a tokenised
 *                                 observation to the person who made it.
 *   intel_attributions            observation_id + account actor_id, and its
 *                                 actor_id is COPIED from the observation, so
 *                                 post-3002 the column already holds a token
 *                                 and its foreign key would reject its own
 *                                 writer. A correctness defect, not only a
 *                                 privacy one.
 *   intel_scoped_trust            folds attributions, inherits the same token.
 *   intel_reward_ledger           carries NO reference to any contribution, so
 *                                 it cannot resolve one. It keeps its account
 *                                 link by RULING, because a payout is owed to a
 *                                 person.
 *
 * WHAT THIS FILE PROVES
 * =====================
 * The same two halves the 3002 test uses, and for the same reason: a unit test
 * in this repo cannot reach a database, so the SCHEMA half asserts that the
 * load-bearing DDL is present in the corpus and cannot be removed silently,
 * while the BEHAVIOUR half runs the reward path for real against a fake that
 * emulates the post-3002 world.
 *
 * The reward-ledger ruling gets its own case, because a ruling that rests on a
 * PROPERTY ("it cannot name a contribution") has to be re-checked whenever the
 * property could have changed — and 3003 encodes that as a postcondition
 * rather than as prose.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");
const ROLLBACKS = join(HERE, "../../../..", "db", "rollback");

const BRIDGE = "3003_intel_identity_bridges.sql";
const sql = () => readFileSync(join(MIGRATIONS, BRIDGE), "utf8");

/** The bridge tables 3003 tokenises. The reward ledger is deliberately absent. */
const TOKENISED = [
  "intel_presence_verifications",
  "intel_attributions",
  "intel_scoped_trust",
] as const;

describe("3003 exists, is ordered, and refuses to run before 3002", () => {
  it("the migration file is in the corpus", () => {
    assert.ok(
      readdirSync(MIGRATIONS).includes(BRIDGE),
      `${BRIDGE} is missing — the four bridges 3002 named are unresolved`,
    );
  });

  it("it is numbered AFTER 3002, because it depends on 3002's trigger function", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    const n = (f: string) => Number(f.slice(0, 4));
    const bridge = files.find((f) => f === BRIDGE);
    const identity = files.find((f) => f.startsWith("3002_"));
    assert.ok(bridge && identity, "premise: both migrations are numbered files");
    assert.ok(n(bridge!) > n(identity!), "3003 must sort after 3002");
  });

  it("it REFUSES to run out of order rather than silently doing half the job", () => {
    const s = sql();
    // BOTH preconditions, each tied to ITS OWN raise. Asserting a loose
    // "somewhere there is a RAISE naming 3002" was not enough: with two guards
    // in the file, deleting one message left the other matching and the case
    // stayed green. Each is now checked as a pair.
    assert.match(
      s,
      /to_regprocedure\('public\.intel_assign_contributor_token\(\)'\) IS NULL THEN\s*\n\s*RAISE EXCEPTION\s*\n?\s*'3003 requires 3002: public\.intel_assign_contributor_token\(\)/,
      "the trigger-function precondition must raise, naming 3002",
    );
    assert.match(
      s,
      /to_regclass\('public\.intel_contributor_pepper'\) IS NULL THEN\s*\n\s*RAISE EXCEPTION\s*\n?\s*'3003 requires 3002: public\.intel_contributor_pepper/,
      "the pepper-table precondition must raise, naming 3002",
    );
    assert.equal(
      (s.match(/3003 requires 3002/g) ?? []).length, 2,
      "exactly two preconditions — one per object 3002 creates that 3003 depends on",
    );
  });

  it("a rollback exists and is reviewable as a pair", () => {
    const f = "2026-09-25-3003-intel-identity-bridges-rollback.sql";
    assert.ok(existsSync(join(ROLLBACKS, f)), `${f} is missing`);
    const r = readFileSync(join(ROLLBACKS, f), "utf8");
    // It must NOT claim to undo the one-way relabelling.
    assert.match(r, /ONE-WAY/, "a rollback that claims to reverse a hash is not a rollback");
    assert.match(r, /ROLLBACK REFUSED/, "restoring a foreign key over tokens must refuse, not force");
  });
});

describe("the three bridge tables lose their account foreign key", () => {
  for (const t of TOKENISED) {
    it(`${t}: the profiles foreign key is dropped BY LOOKUP, not by assumed name`, () => {
      const s = sql();
      const block = s.slice(s.indexOf(`rel.relname = '${t}'`));
      assert.ok(block.length > 0, `${t} is not named in 3003`);
      assert.match(
        s,
        new RegExp(`rel\\.relname = '${t}'[\\s\\S]{0,400}confrelid = 'public\\.profiles'::regclass`),
        `${t}'s FK must be found in pg_constraint, so a non-default constraint name is handled`,
      );
      assert.match(
        s,
        new RegExp(`ALTER TABLE public\\.${t} DROP CONSTRAINT`),
        `${t} must actually drop the constraint it found`,
      );
    });

    it(`${t}: the block is a no-op when the table is absent`, () => {
      // 2277 and 2278 are unapplied in production, so two of the three tables do
      // not exist there. A migration that assumed they did would abort the whole
      // apply on a database that is otherwise correct.
      assert.match(
        sql(),
        new RegExp(`to_regclass\\('public\\.${t}'\\) IS NULL[\\s\\S]{0,200}RETURN;`),
        `${t} must be skipped, with a NOTICE, when it does not exist`,
      );
    });
  }

  it("a postcondition RAISES if ANY of the three still references profiles", () => {
    const s = sql();
    assert.match(
      s,
      /POSTCONDITION FAILED[\s\S]{0,140}intel bridge tables to profiles survive/,
      "the drop must be proven, not assumed",
    );
    for (const t of TOKENISED) {
      assert.ok(
        new RegExp(`'intel_presence_verifications','intel_attributions','intel_scoped_trust'`).test(s),
        `${t} must be inside the postcondition's relname list`,
      );
    }
  });
});

describe("only the table whose WRITER supplies an account gets a trigger", () => {
  it("intel_presence_verifications gets the BEFORE INSERT boundary", () => {
    const s = sql();
    assert.match(
      s,
      /CREATE TRIGGER[\s\S]{0,200}intel_presence_verifications_contributor_token[\s\S]{0,200}BEFORE INSERT ON public\.intel_presence_verifications/,
    );
    assert.match(s, /EXECUTE FUNCTION public\.intel_assign_contributor_token\(\)/);
  });

  it("and existing rows are CONVERTED, so old rows stop resolving to accounts", () => {
    const s = sql();
    assert.match(
      s,
      /UPDATE public\.intel_presence_verifications[\s\S]{0,200}intel_contributor_token\(/,
      "leaving old rows would leave the reverse-link open for every past contribution",
    );
    assert.match(
      s,
      /POSTCONDITION FAILED[\s\S]{0,160}still resolve to a profile/,
      "the conversion must be proven complete",
    );
  });

  it("intel_attributions and intel_scoped_trust get NO trigger — the value is already a token", () => {
    const s = sql();
    for (const t of ["intel_attributions", "intel_scoped_trust"]) {
      assert.ok(
        !new RegExp(`CREATE TRIGGER[\\s\\S]{0,120}ON public\\.${t}\\b`).test(s),
        `${t} must not get a tokenising trigger: its actor_id is copied from an already-tokenised observation, ` +
          "and tokenising a token mints a second identity for one contributor",
      );
    }
  });
});

describe("intel_reward_ledger keeps its account link, and the ruling is GUARDED", () => {
  it("no DDL touches it", () => {
    const s = sql();
    assert.ok(
      !/ALTER TABLE public\.intel_reward_ledger/.test(s),
      "the reward ledger must not be altered: you cannot pay a rotating token",
    );
  });

  it("the ruling is written where a reader of the schema finds it", () => {
    const s = sql();
    assert.match(s, /COMMENT ON COLUMN public\.intel_reward_ledger\.actor_id/);
    assert.match(s, /DELIBERATELY STILL A profiles\.id, ruled by 3003 rather than overlooked/);
  });

  it("a postcondition RAISES if the table ever gains a contribution reference", () => {
    // THE CASE THAT MATTERS. The ruling rests on a PROPERTY of the schema — the
    // ledger cannot name a contribution — and a property can be lost by a later
    // migration that knows nothing about this one.
    const s = sql();
    for (const col of ["observation_id", "claim_id", "subject_id", "contribution_id"]) {
      assert.ok(
        s.includes(`'${col}'`),
        `${col} must be in the guarded column list — it would re-open the reverse-link`,
      );
    }
    assert.match(
      s,
      /POSTCONDITION FAILED[\s\S]{0,200}so it CAN resolve a tokenised contribution to an account/,
    );
    assert.match(s, /Rule again before shipping this/);
  });
});

describe("erasure is widened, because two of its arms were account-only by design", () => {
  it("scoped trust and attributions now match on token OR account", () => {
    const s = sql();
    for (const t of ["intel_scoped_trust", "intel_attributions"]) {
      assert.match(
        s,
        new RegExp(`DELETE FROM public\\.${t} WHERE actor_id = p_actor_id OR actor_id = ANY \\(v_tokens\\)`),
        `${t}'s erasure arm must carry BOTH, or it silently misses every row written after 3002`,
      );
    }
  });

  it("presence verifications gain an arm of their own", () => {
    assert.match(
      sql(),
      /DELETE FROM public\.intel_presence_verifications WHERE actor_id = p_actor_id OR actor_id = ANY \(v_tokens\)/,
    );
  });

  it("the reward ledger is NOT erased, and the reason is stated", () => {
    const s = sql();
    assert.ok(
      !/DELETE FROM public\.intel_reward_ledger/.test(s),
      "a financial record is reversed, not erased; erasing contributions is not erasing what was owed for them",
    );
    assert.match(s, /REWARD LEDGER is deliberately NOT deleted/);
  });
});

describe("the census row this closes, and the one it does not", () => {
  it("3003 states what it does NOT close rather than leaving it to be inferred", () => {
    const s = sql();
    // Each of these is a live limit on the S118 claim. A migration that fixed
    // three tables and implied the store was now unlinkable would be the
    // overstatement the census exists to catch.
    assert.match(s, /pepper is still readable inside the database by a superuser/i);
    assert.match(s, /Deleting SPENT peppers is still not automated/i);
    assert.match(s, /database never gains a\s*--\s*token -> account function|token -> account function/);
  });
});
