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
