/**
 * The `client && await isKillSwitchEngaged(...)` fail-open, as a RATCHET.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * Guarding a kill-switch read behind a truthiness test on the service client
 * READS as fail-closed and is not. Both operands of that `&&` are the SAME
 * FACT — the stop's state could not be established — and only one of them was
 * treated that way: an unreadable `feature_flags` engaged the stop, while an
 * absent service client skipped the check entirely and let the write through.
 *
 * What a person saw on the ordinary Telegraph send door, the highest-traffic
 * one in the product: `201 Created`. The message was written. Nothing was
 * logged and nothing was returned, so the outcome was not merely
 * indistinguishable from success — IT WAS SUCCESS.
 *
 * The asymmetry inside one route is what made it plain:
 * `POST /api/telegraph/voice/upload` already refused a null service client with
 * `server_not_configured`, while the send door beside it wrote.
 *
 * ── WHY THIS IS A SOURCE ASSERTION, SAID PLAINLY RATHER THAN DISGUISED ──────
 * It is NOT a behavioural test and does not claim to be. `getServiceClient()`
 * returns a real client whenever `SUPABASE_SERVICE_ROLE_KEY` is set, and the
 * curated `test` script sets it to "dummy" on the command line, so the null-
 * client branch is UNREACHABLE from inside this process. Reaching it needs a
 * process spawned with the variable stripped.
 *
 * The DECISION is tested behaviourally, where it can be: the predicate
 * `messagingStopUnknownRefusal` is exercised directly in
 * `verifyFailureRecovery.test.ts`, which is exactly why the verification lane
 * exported it instead of inlining the check. What is left over — "does every
 * door in this file actually call it" — cannot be observed at runtime here, and
 * a grep that says so out loud is worth more than no guard at all.
 *
 * So the value of this file is as a RATCHET on a CLASS, not a proof of a case:
 * the shape is easy to reintroduce, reads as safe to a reviewer, and its
 * failure mode is silent. If this test ever fails, do not relax the pattern —
 * route the new door through `messagingStopUnknownRefusal` like the others.
 *
 * SHOWN RED BEFORE COMMIT, TWICE, and the second time is the point of the file.
 * First: 3 occurrences in routes/messaging.ts (the text-send door and both media
 * stops), matching the three the verification lane reported as still live after
 * it fixed the four Telegraph routes it owned. Those were fixed.
 *
 * It went red AGAIN on three doors nobody had looked at, outside Telegraph
 * entirely, which is how a class-level ratchet earns its place over a list of
 * known sites:
 *
 *   routes/meetups.ts   disable_new_event_creation
 *   routes/location.ts  disable_location_sharing   <- a safety stop
 *   routes/posts.ts     disable_posting
 *
 * All three are fixed through `killSwitchStateUnknown` in lib/featureFlags.ts,
 * which is where the next person writing a kill switch will meet it.
 *
 * ── A SECOND SHAPE OF THE SAME CLASS (2026-10-06, PR #588's verification) ────
 * The pattern above matches a kill switch skipped because the client is absent.
 * It does NOT match a restriction read through the false-on-error reader:
 *
 *     isFlagEnabled(db, "layover_entry_forbid_landside_enabled")
 *
 * There is no `&&`, no `isKillSwitchEngaged` and no `disable_` in that line, so
 * it sailed past this file — and past `check:flag-polarity`, which classifies
 * `*_enabled` as a CAPABILITY by convention and is satisfied by `isFlagEnabled`.
 * But for that flag ON is the RESTRICTIVE state, so "false on error" is "the
 * restriction is off": a failed read left the landside gate open. The second
 * describe below is the ratchet for that shape, keyed on the registry in
 * lib/featureFlags.ts (`RESTRICTIVE_WHEN_ON_FLAGS`), with the two lines that
 * escaped transcribed as its fixture.
 *
 * Run: node --import tsx/esm --test src/test/verifyFailOpenStopReads.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROUTES = path.resolve(import.meta.dirname, "../routes");
const LIB = path.resolve(import.meta.dirname, "../lib");

/**
 * A stop read guarded by a truthiness test on the client, in the two spellings
 * this tree has used. Deliberately narrow: it matches the DEFECT, not every
 * mention of the function, so it cannot be satisfied by renaming a variable.
 */
const FAIL_OPEN = /\b(\w+)\s*&&\s*await\s+isKillSwitchEngaged\s*\(\s*\1\b/;

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? sourcesUnder(path.join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [path.join(dir, e.name)]
          : [],
    );
}

describe("a kill switch is never skipped because the service client is absent", () => {
  it("no route guards a stop read behind a truthiness test on the client", () => {
    const offenders = sourcesUnder(ROUTES)
      .filter((f) => FAIL_OPEN.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROUTES, f));

    assert.deepEqual(
      offenders,
      [],
      "Each of these skips its kill switch entirely when getServiceClient() returns null, and the " +
        "caller cannot tell: the write succeeds. Route the door through " +
        "messagingStopUnknownRefusal(flagSc) — which returns a degraded_unavailable refusal, NOT " +
        "feature_disabled, because nobody engaged a stop; we could not look.",
    );
  });

  it("no lib does either — the same shape is worse one layer down, where several routes inherit it", () => {
    const offenders = sourcesUnder(LIB)
      .filter((f) => FAIL_OPEN.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(LIB, f));

    assert.deepEqual(offenders, [], "see the message above; a shared guard multiplies the defect");
  });

  it("the predicate the doors are supposed to use still exists and still refuses a null client", async () => {
    // A ratchet that points at a function nobody exports is a ratchet that has
    // quietly stopped meaning anything.
    const { messagingStopUnknownRefusal } = await import("../lib/telegraphThreadWrite.js");
    assert.equal(messagingStopUnknownRefusal({} as unknown), null, "a client we have is not an unknown");
    const refusal = messagingStopUnknownRefusal(null);
    assert.ok(refusal, "a client we do not have must refuse");
    assert.equal(
      refusal.code,
      "degraded_unavailable",
      "NOT feature_disabled: nobody engaged a stop, we could not establish whether one was engaged",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A restriction named like a capability, read through a false-on-error reader
// ═════════════════════════════════════════════════════════════════════════════

const SRC = path.resolve(import.meta.dirname, "..");

/** Every production source under src/: no tests, no fixtures. */
function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" || e.name === "__tests__" || e.name === "node_modules" ? [] : productionSources(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

/**
 * The readers that answer FALSE (or null) when `feature_flags` cannot be read.
 * `readFlagState` is deliberately absent: it is the one that says `unreadable`.
 */
const FALSE_ON_ERROR_READERS = ["isFlagEnabled", "isEnabled", "isLivePlacesCapabilityEnabled", "getFlagRow"];

/**
 * A false-on-error reader called with `flag` — as a literal, or through a
 * member of a constants object (`isFlagEnabled(db, FLAGS.storage)`), which is
 * the spelling a refactor of the literal form would most naturally take.
 */
function failOpenRestrictionRead(flag: string, constantMembers: string[] = []): RegExp {
  const quoted = `["'\`]${flag}["'\`]`;
  const viaConstant = constantMembers.map((m) => m.replace(/[.$]/g, "\\$&"));
  const arg = [quoted, ...viaConstant].join("|");
  return new RegExp(`\\b(?:${FALSE_ON_ERROR_READERS.join("|")})\\s*\\(\\s*[^,()]+,\\s*(?:${arg})\\s*[,)]`);
}

/** How the store's constants object spells each registered flag. */
const CONSTANT_SPELLINGS: Record<string, string[]> = {
  layover_constraints_enabled: ["LAYOVER_CONSTRAINT_FLAGS.storage"],
  layover_entry_forbid_landside_enabled: ["LAYOVER_CONSTRAINT_FLAGS.entryForbidsLandside"],
};

describe("a flag whose ON is the restrictive state is never read through a false-on-error reader", () => {
  /**
   * THE LINES THAT ESCAPED, transcribed from
   * services/layover/LayoverConstraintStore.ts:66-69 at origin/main 5f7cf6b58
   * (PR #588). Not paraphrased: a ratchet proven against a tidier version of the
   * defect than the one that shipped proves nothing about the one that shipped.
   */
  const ESCAPED = [
    "  const [storage, entryForbidsLandside] = await Promise.all([",
    "    isFlagEnabled(db, \"layover_constraints_enabled\"),",
    "    isFlagEnabled(db, \"layover_entry_forbid_landside_enabled\"),",
    "  ]);",
  ].join("\n");

  it("the registry names the two flags, and each is one a person is refused something by", async () => {
    const { RESTRICTIVE_WHEN_ON_FLAGS } = await import("../lib/featureFlags.js");
    assert.deepEqual([...RESTRICTIVE_WHEN_ON_FLAGS].sort(), ["layover_constraints_enabled", "layover_entry_forbid_landside_enabled"]);
    for (const flag of RESTRICTIVE_WHEN_ON_FLAGS) {
      assert.ok(CONSTANT_SPELLINGS[flag], `${flag} is registered and this ratchet does not know how a constants object spells it`);
    }
  });

  it("FIXTURE: the pattern matches the lines that shipped — and the older ratchet does not, which is how they escaped", async () => {
    const { RESTRICTIVE_WHEN_ON_FLAGS } = await import("../lib/featureFlags.js");
    for (const flag of RESTRICTIVE_WHEN_ON_FLAGS) {
      assert.match(ESCAPED, failOpenRestrictionRead(flag, CONSTANT_SPELLINGS[flag]), `${flag}: the ratchet cannot see the read that escaped`);
    }
    assert.equal(FAIL_OPEN.test(ESCAPED), false, "the kill-switch ratchet DOES match these lines, so this second one is redundant — delete it rather than keep two");
    // The same defect spelled through the constants object, and with spacing.
    assert.match("await isFlagEnabled(db, LAYOVER_CONSTRAINT_FLAGS.storage)", failOpenRestrictionRead("layover_constraints_enabled", CONSTANT_SPELLINGS.layover_constraints_enabled));
    assert.match("isFlagEnabled( sc ,'layover_entry_forbid_landside_enabled' )", failOpenRestrictionRead("layover_entry_forbid_landside_enabled"));
    assert.match("const row = await getFlagRow(sc, `layover_constraints_enabled`);", failOpenRestrictionRead("layover_constraints_enabled"));
  });

  it("NEGATIVE CONTROL: the three-valued read, a comment and a DIFFERENT flag are not matched", () => {
    const fixed = [
      "    readFlagState(db, \"layover_constraints_enabled\"),",
      "    readFlagState(db, \"layover_entry_forbid_landside_enabled\"),",
      "  storage: \"layover_constraints_enabled\",",
      "  if (!(await isFlagEnabled(sc, \"airport_mode_enabled\"))) { sendError(res, \"feature_disabled\"); return null; }",
      "  isFlagEnabled(db, \"layover_constraints_enabled_v2\")",
    ].join("\n");
    for (const flag of ["layover_constraints_enabled", "layover_entry_forbid_landside_enabled"]) {
      assert.equal(failOpenRestrictionRead(flag, CONSTANT_SPELLINGS[flag]).test(fixed), false, flag);
    }
  });

  it("no production source reads a restrictive-when-ON flag through a false-on-error reader", async () => {
    const { RESTRICTIVE_WHEN_ON_FLAGS } = await import("../lib/featureFlags.js");
    const sources = await readProductionSources();
    assert.ok(sources.length > 500, `VACUOUS: only ${sources.length} production sources were scanned`);
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const flag of RESTRICTIVE_WHEN_ON_FLAGS) {
        if (failOpenRestrictionRead(flag, CONSTANT_SPELLINGS[flag]).test(text)) offenders.push(`${path.relative(SRC, file)} reads ${flag}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "For each of these flags ON is the restrictive state, so a reader that answers `false` on a database " +
        "error turns the restriction OFF exactly when it could not be read. Read it through readFlagState " +
        "(lib/capability/schemaCapability.ts) and close on `unreadable`.",
    );
  });

  it("NON-VACUITY: each registered flag IS read somewhere, three-valued — a flag nobody reads cannot fail open or closed", async () => {
    const { RESTRICTIVE_WHEN_ON_FLAGS } = await import("../lib/featureFlags.js");
    const files = (await readProductionSources()).map((s) => s.text);
    for (const flag of RESTRICTIVE_WHEN_ON_FLAGS) {
      const threeValued = new RegExp(`\\breadFlagState\\s*\\(\\s*[^,()]+,\\s*["'\`]${flag}["'\`]`);
      assert.ok(files.some((text) => threeValued.test(text)), `${flag} is registered as restrictive and no production source reads it through readFlagState`);
    }
  });
});

/**
 * List AND read every production source under the tree lock.
 *
 * `guardCoverageReachability.test.ts` writes a probe into src/lib/ and deletes
 * it again, and node:test runs files concurrently: a scan that lists the tree,
 * then reads it, can list the probe and find it gone (ENOENT — a red that is
 * about another suite's timing, not about a flag). The two full-tree
 * flag-polarity scans take this lock for the same reason (#623).
 */
async function readProductionSources(): Promise<Array<{ file: string; text: string }>> {
  const release = await acquireTreeLock("verifyFailOpenStopReads restrictive-flag scan");
  try {
    return productionSources(SRC).map((file) => ({ file, text: readFileSync(file, "utf8") }));
  } finally {
    release();
  }
}

// At the tail, where flagPolaritySeedScan.test.ts and flagPhantomReads.test.ts
// import it too (an ESM import is hoisted wherever it is written).
import { acquireTreeLock } from "./helpers/treeMutationLock.js";
