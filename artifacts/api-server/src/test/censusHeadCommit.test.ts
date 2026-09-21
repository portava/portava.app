/**
 * Telling a MALFORMED census declaration from a deliberately absent one.
 *
 * WHAT THIS GUARDS, AND THE DAY IT WAS NEEDED
 * ===========================================
 * `check:census-freshness` had two branches where it needed three. A census
 * that declared no head_commit was reported "CANNOT BE CHECKED" and did not
 * fail the run — correct, because census-passport.md deliberately declares
 * none. A census that TRIED to declare one and got the shape wrong fell into
 * the same branch.
 *
 * On 2026-09-09 census-trips' declaration was written with bold marks between
 * the pipe and the hash: `| **\`c3f76a49\`** — …`. The parser missed it, the
 * run said "no head_commit declared", and PASSED. A document whose author had
 * just written a commit hash into it was silently reclassified as one that
 * never had, and was then aged by nothing while appearing to be aged.
 *
 * Both halves are pinned below: the shapes that must parse, and the shapes
 * that must FAIL rather than quietly downgrade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { readHeadCommit, HEAD_COMMIT_ROW_SHAPE } from "../scripts/lib/censusHeadCommit.js";

describe("a well-formed declaration parses", () => {
  it("the plain row", () => {
    const r = readHeadCommit("| `head_commit` | `c3f76a49` |");
    assert.deepEqual(r, { kind: "declared", commit: "c3f76a49" });
  });

  it("a full sha, and prose AFTER the hash", () => {
    const r = readHeadCommit(
      "| `head_commit` | `743ae78f305ea657ab508a34bdbc574488f4aae7` (`git rev-parse HEAD`) — §9 measured earlier |",
    );
    assert.equal(r.kind, "declared");
    assert.equal((r as any).commit, "743ae78f305ea657ab508a34bdbc574488f4aae7");
  });

  it("an unbackticked hash", () => {
    assert.equal((readHeadCommit("| head_commit | abc1234 |") as any).commit, "abc1234");
  });
});

describe("a MALFORMED declaration fails rather than downgrading", () => {
  it("THE ACTUAL BUG: bold marks between the pipe and the hash", () => {
    // This exact string passed the whole check on 2026-09-09.
    assert.deepEqual(readHeadCommit("| `head_commit` | **`c3f76a49`** — §29 measured `823b6d67` |"), {
      kind: "malformed",
    });
  });

  it("a word before the hash", () => {
    assert.deepEqual(readHeadCommit("| `head_commit` | commit `c3f76a49` |"), { kind: "malformed" });
  });

  it("a link around the hash", () => {
    assert.deepEqual(readHeadCommit("| `head_commit` | [`c3f76a49`](http://x) |"), { kind: "malformed" });
  });

  it("a declaration row with no hash in it at all", () => {
    assert.deepEqual(readHeadCommit("| `head_commit` | not measured yet |"), { kind: "malformed" });
  });

  it("a hash too short to be one", () => {
    // Six characters is not a git prefix this check will act on, and silently
    // accepting it would make `git diff` fail later with a worse message.
    assert.deepEqual(readHeadCommit("| `head_commit` | `abc123` |"), { kind: "malformed" });
  });
});

describe("a deliberate ABSENCE is not a failure", () => {
  it("prose saying the census declares none", () => {
    // census-passport.md's actual sentence.
    assert.deepEqual(
      readHeadCommit("**This census still declares NO `head_commit`, deliberately.** The 169 verdicts…"),
      { kind: "absent" },
    );
  });

  it("a document that never mentions it", () => {
    assert.deepEqual(readHeadCommit("# A census\n\nSome rows.\n"), { kind: "absent" });
  });

  it("head_commit named inside a code fence, not a table cell", () => {
    assert.deepEqual(readHeadCommit("```\nCENSUS_SCOPE has no head_commit entry\n```"), { kind: "absent" });
  });
});

describe("the real corpus", () => {
  const dir = join(new URL("../../../../", import.meta.url).pathname.replace(/\/$/, ""), "docs/architecture");

  it("no committed census carries a malformed declaration", () => {
    // The check's own output for a malformed one is an error, so this failing
    // means a census is currently unaged while looking aged.
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.startsWith("census-") && n.endsWith(".md"))) {
      if (readHeadCommit(readFileSync(join(dir, f), "utf8")).kind === "malformed") bad.push(f);
    }
    assert.deepEqual(bad, []);
  });

  it("census-trips declares one, and it is the FIRST such row in the file", () => {
    // The parser takes the first match. §30 adds a second section that measures
    // a newer commit, and the declaration is updated IN PLACE in §29's table
    // rather than re-declared lower down — a second row would look like a
    // declaration, age nothing, and be invisible to this check.
    const text = readFileSync(join(dir, "census-trips.md"), "utf8");
    const r = readHeadCommit(text);
    assert.equal(r.kind, "declared");
    const rows = [...text.matchAll(/head_commit`?\s*\|\s*`?([0-9a-f]{7,40})/gi)];
    assert.equal(rows.length, 1,
      `census-trips declares ${rows.length} head_commit rows; only the first is ever read`);
  });

  it("the error text and the parser cannot drift apart", () => {
    // The message tells an author what shape to write. If it stops describing
    // what the regex accepts, it sends them to write the same bug again.
    assert.match(HEAD_COMMIT_ROW_SHAPE, /immediately after the pipe/);
    assert.match(HEAD_COMMIT_ROW_SHAPE, /Bold marks/);
  });
});
