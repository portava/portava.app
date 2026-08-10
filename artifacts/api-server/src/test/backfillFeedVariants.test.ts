/**
 * backfillFeedVariants — the safety properties, tested.
 *
 * This is a job that writes to Storage and to the database, so the things worth
 * pinning are not "does it resize an image" (makeFeedVariant is covered by
 * photoCeilingExifStrip.test.ts and mediaUploadHardening.test.ts) but the
 * properties that decide whether an operator can trust a run:
 *
 *   - it does not write unless explicitly told to
 *   - a partial success reports as a failure
 *   - a resumed run does not lose or double-count work
 *   - the variant path matches the one the LIVE path writes, or the two would
 *     strand each other's objects
 *
 * The module is import-safe on purpose: everything below its "Main" banner is
 * behind a RUN_DIRECTLY guard, so importing it here performs no network calls,
 * no filesystem writes and no process.exit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  ArgError,
  variantPathFor,
  decideExitCode,
  parseCheckpoint,
} from "../scripts/backfillFeedVariants.js";

describe("backfillFeedVariants — argument safety", () => {
  it("defaults to a DRY RUN: no argv means no writes", () => {
    // The single most important default in the file. If this ever flips, a bare
    // `pnpm run backfill:feed-variants` starts mutating production.
    const o = parseArgs([]);
    assert.equal(o.apply, false);
    assert.equal(o.auditExif, false);
    assert.equal(o.reset, false);
  });

  it("writes only when --apply is passed explicitly", () => {
    assert.equal(parseArgs(["--limit", "50"]).apply, false);
    assert.equal(parseArgs(["--apply"]).apply, true);
  });

  it("carries sane defaults for limit and rate", () => {
    const o = parseArgs([]);
    assert.equal(o.limit, 100);
    assert.equal(o.rateMs, 250, "rate limiting must be on by default, not opt-in");
    assert.equal(o.statePath, ".backfill-feed-variants.json");
  });

  it("rejects a --limit that is not a positive integer", () => {
    for (const bad of ["0", "-5", "abc", "1.5"]) {
      assert.throws(() => parseArgs(["--limit", bad]), ArgError, `--limit ${bad} should be rejected`);
    }
    assert.equal(parseArgs(["--limit", "250"]).limit, 250);
  });

  it("accepts --rate-ms 0 but rejects negatives and junk", () => {
    assert.equal(parseArgs(["--rate-ms", "0"]).rateMs, 0, "0 is a legitimate 'no delay'");
    assert.throws(() => parseArgs(["--rate-ms", "-1"]), ArgError);
    assert.throws(() => parseArgs(["--rate-ms", "fast"]), ArgError);
  });

  it("refuses --apply together with --audit-exif", () => {
    // audit-exif is documented read-only. Silently ignoring one of the two
    // flags would mean the operator's mental model and the run disagree.
    assert.throws(() => parseArgs(["--apply", "--audit-exif"]), ArgError);
  });

  it("does not let a valueless flag swallow the next one", () => {
    // `--limit --apply` must not parse as limit="--apply" with --apply lost.
    // That specific bug would silently drop the write flag, or worse, keep it
    // while corrupting the limit.
    assert.throws(() => parseArgs(["--limit", "--apply"]), ArgError);
    assert.throws(() => parseArgs(["--state"]), ArgError);
  });
});

describe("backfillFeedVariants — failure accounting", () => {
  it("a run with zero failures exits 0", () => {
    assert.equal(decideExitCode(0), 0);
  });

  it("a PARTIAL success exits non-zero — 400 of 500 failing is not a pass", () => {
    assert.equal(decideExitCode(400), 1);
    assert.equal(decideExitCode(1), 1, "even a single failure must fail the run");
  });
});

describe("backfillFeedVariants — variant path", () => {
  it("matches the convention the live upload paths write", () => {
    // routes/postcards.ts writes `${storagePath}.feed.jpg` and
    // routes/posts.ts writes `${basePath}.feed.jpg`. If this function drifts,
    // the backfill writes objects the delete path never cleans up and
    // check:media-objects starts reporting orphans forever.
    assert.equal(
      variantPathFor("user/post/media.jpg"),
      "user/post/media.jpg.feed.jpg",
    );
  });

  it("is derived from the original path, never from the row id", () => {
    // Deriving from the id would decouple the variant from the object it came
    // from and break the delete path, which removes `${storage_path}.feed.jpg`.
    const p = "92602b6c/62252a3d/db1bc238.jpg";
    assert.ok(variantPathFor(p).startsWith(p));
  });
});

describe("backfillFeedVariants — checkpoint", () => {
  it("round-trips a well-formed checkpoint", () => {
    const c = parseCheckpoint(JSON.stringify({ done: ["a", "b"], failed: ["c"], updatedAt: "x" }));
    assert.deepEqual(c.done, ["a", "b"]);
    assert.deepEqual(c.failed, ["c"]);
  });

  it("rejects a malformed checkpoint rather than reading it as empty", () => {
    // Silently treating corruption as "nothing done" is survivable here (the
    // feed_url IS NULL filter still makes the run idempotent) but it must be a
    // decision the caller makes after seeing a throw, not something the parser
    // papers over.
    assert.throws(() => parseCheckpoint('{"done":"not-an-array","failed":[]}'));
    assert.throws(() => parseCheckpoint("{ not json"));
  });

  it("keeps failed ids separate from done ids so a resume RETRIES them", () => {
    // The distinction is the whole point: a resumed run must not treat a
    // previously-failed row as finished work.
    const c = parseCheckpoint(JSON.stringify({ done: ["ok-1"], failed: ["bad-1"], updatedAt: "" }));
    assert.ok(!c.done.includes("bad-1"), "a failed id must never appear as done");
    assert.ok(c.failed.includes("bad-1"));
  });
});
