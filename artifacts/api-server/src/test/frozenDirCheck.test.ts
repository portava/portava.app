/**
 * Frozen-dir guard rewrite — checkRoot / sweepForUnlisted / runFrozenDirCheck
 *
 * checkFrozenDir.ts (the CI-facing script) is a top-level-executing script
 * that calls process.exit(), so it can't be imported directly in a test.
 * frozenDirCheck.ts was pulled out specifically so these functions ARE
 * directly testable, against real temp directories on disk (not mocks) —
 * this exercises real fs.readdirSync/statSync/readFileSync behavior, which
 * matters here because the whole point of the rewrite is filesystem-state
 * detection (added/removed/modified/missing-entirely).
 *
 * Covers the four bugs the rewrite fixes, in order:
 *   A. modification-blind  → content hash comparison catches in-place edits
 *   B. missing-root silent pass → a vanished root reports every known file
 *      as removed, not zero problems
 *   C. deletion-blind → every expected filename is checked for presence
 *   D. two hardcoded paths → the root list is data (proven by using 3+ roots
 *      and confirming each is diffed independently)
 * Plus the new requirement: an unlisted root (a migration-shaped .sql file
 * outside every known root) fails rather than passing silently.
 *
 * ALLOWLISTED_ROOTS coverage (added when reconciliation-staging/ and
 * artifacts/api-server/baseline/ joined the repo): these two directories
 * hold migration-shaped .sql filenames legitimately, so they must be
 * exempted from the sweep — but ONLY by explicit name. The load-bearing
 * property here is the same one bug D fixed for FrozenRoot: allowlisting
 * must not become a way to silence the sweep in general. A THIRD,
 * unlisted root must still fail exactly as before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRoot,
  checkLooseFiles,
  sweepForUnlisted,
  checkNonExecutableOverlap,
  runFrozenDirCheck,
  sha256,
} from "../scripts/frozenDirCheck.js";
import { FROZEN_ROOTS, FROZEN_LOOSE_FILES, ALLOWLISTED_ROOTS } from "../scripts/frozenMigrationRoots.js";

function makeTempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "frozen-dir-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("checkRoot — bug A: content-modification detection", () => {
  it("flags a file whose content changed even though the filename didn't", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "frozen/0001_a.sql", "CREATE TABLE a (id uuid);");
      const expected = { "0001_a.sql": sha256(join(root, "frozen/0001_a.sql")) };

      // No-op run: unchanged content must report clean.
      let diff = checkRoot(root, "frozen", "test root", expected);
      assert.deepEqual(diff.modified, [], "unchanged content must not be flagged");

      // Mutate in place — same filename, different bytes.
      write(root, "frozen/0001_a.sql", "CREATE TABLE a (id uuid, evil text);");
      diff = checkRoot(root, "frozen", "test root", expected);
      assert.deepEqual(diff.modified, ["0001_a.sql"], "in-place content change must be caught");
      assert.deepEqual(diff.added, []);
      assert.deepEqual(diff.removed, []);
    } finally {
      cleanup();
    }
  });
});

describe("checkRoot — bug B: missing-root-entirely is a failure, not a pass", () => {
  it("reports every known file as removed when the whole directory is gone", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      const expected = { "0001_a.sql": "deadbeef", "0002_b.sql": "cafef00d" };
      // "frozen" directory never created at all.
      const diff = checkRoot(root, "frozen", "test root", expected);
      assert.equal(diff.missingDirEntirely, true);
      assert.deepEqual(diff.removed, ["0001_a.sql", "0002_b.sql"]);
    } finally {
      cleanup();
    }
  });

  it("an EMPTY expected set for a missing dir is not itself a failure", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      const diff = checkRoot(root, "frozen", "test root", {});
      assert.equal(diff.missingDirEntirely, false);
      assert.deepEqual(diff.removed, []);
    } finally {
      cleanup();
    }
  });
});

describe("checkRoot — bug C: deletion detection", () => {
  it("flags a known file that was deleted while its siblings remain", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "frozen/0001_a.sql", "A");
      write(root, "frozen/0002_b.sql", "B");
      const expected = {
        "0001_a.sql": sha256(join(root, "frozen/0001_a.sql")),
        "0002_b.sql": sha256(join(root, "frozen/0002_b.sql")),
      };
      // Delete just one of the two known files.
      rmSync(join(root, "frozen/0002_b.sql"));
      const diff = checkRoot(root, "frozen", "test root", expected);
      assert.deepEqual(diff.removed, ["0002_b.sql"]);
      assert.deepEqual(diff.added, []);
      assert.deepEqual(diff.modified, []);
    } finally {
      cleanup();
    }
  });

  it("still flags an ADDED file (pre-existing behavior, must not regress)", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "frozen/0001_a.sql", "A");
      const expected = { "0001_a.sql": sha256(join(root, "frozen/0001_a.sql")) };
      write(root, "frozen/9999_sneaky.sql", "sneaky");
      const diff = checkRoot(root, "frozen", "test root", expected);
      assert.deepEqual(diff.added, ["9999_sneaky.sql"]);
    } finally {
      cleanup();
    }
  });
});

describe("bug D: root list is data, not hardcoded — runFrozenDirCheck takes N roots", () => {
  it("diffs three independent roots correctly in one run", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "rootA/0001_a.sql", "a-content");
      write(root, "rootB/0001_b.sql", "b-content-MODIFIED");
      // rootC is entirely absent.

      const roots = [
        { relPath: "rootA", label: "A", files: { "0001_a.sql": sha256(join(root, "rootA/0001_a.sql")) } },
        { relPath: "rootB", label: "B", files: { "0001_b.sql": "not-the-real-hash" } },
        { relPath: "rootC", label: "C", files: { "0001_c.sql": "irrelevant" } },
      ];
      const result = runFrozenDirCheck(root, "canonical", roots, {});
      assert.equal(result.rootDiffs.length, 3);
      assert.equal(result.passed, false);

      const a = result.rootDiffs.find((d) => d.relPath === "rootA")!;
      assert.deepEqual([a.added, a.removed, a.modified], [[], [], []], "rootA is genuinely clean");

      const b = result.rootDiffs.find((d) => d.relPath === "rootB")!;
      assert.deepEqual(b.modified, ["0001_b.sql"]);

      const c = result.rootDiffs.find((d) => d.relPath === "rootC")!;
      assert.equal(c.missingDirEntirely, true);
    } finally {
      cleanup();
    }
  });
});

describe("sweepForUnlisted — the new requirement", () => {
  it("flags a migration-shaped file in a brand-new, unlisted directory", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "known-root/0001_k.sql", "known");
      // A NEW directory nobody listed, holding a migration-shaped file —
      // exactly the shape of the artifacts/api-server/supabase/migrations
      // incident this requirement exists to catch.
      write(root, "sneaky-new-root/20270101_surprise.sql", "surprise");

      const roots = [{ relPath: "known-root" }];
      const hits = sweepForUnlisted(root, "canonical", roots, {});
      assert.deepEqual(hits, [join("sneaky-new-root", "20270101_surprise.sql")]);
    } finally {
      cleanup();
    }
  });

  it("does not flag files inside the canonical dir or a known root", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "known-root/0001_k.sql", "known");
      const roots = [{ relPath: "known-root" }];
      const hits = sweepForUnlisted(root, "canonical", roots, {});
      assert.deepEqual(hits, []);
    } finally {
      cleanup();
    }
  });

  it("does not flag an individually-pinned loose file", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "0002_loose.sql", "loose but known");
      const hits = sweepForUnlisted(root, "canonical", [], { "0002_loose.sql": "irrelevant-hash" });
      assert.deepEqual(hits, []);
    } finally {
      cleanup();
    }
  });

  it("flags an unlisted LOOSE file that isn't pinned, even with no new directory", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "0002_surprise_loose.sql", "surprise");
      const hits = sweepForUnlisted(root, "canonical", [], {});
      assert.deepEqual(hits, ["0002_surprise_loose.sql"]);
    } finally {
      cleanup();
    }
  });

  it("does not descend into skipped directory names (node_modules etc.)", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "node_modules/some-pkg/0001_looks_like_a_migration.sql", "vendored, irrelevant");
      const hits = sweepForUnlisted(root, "canonical", [], {});
      assert.deepEqual(hits, [], "node_modules must never be swept");
    } finally {
      cleanup();
    }
  });

  it("does not descend into the managed portava.app artifact mirror", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "portava.app/artifacts/api-server/src/migrations/2123_mirrored.sql", "mirror");
      const hits = sweepForUnlisted(root, "canonical", [], {});
      assert.deepEqual(hits, [], "managed artifact mirrors must not be treated as new migration roots");
    } finally {
      cleanup();
    }
  });

  it("recognizes both the 4-digit and 8-digit dated numeric-prefix conventions", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "rogue/0042_four_digit.sql", "x");
      write(root, "rogue/20270615_eight_digit_dated.sql", "y");
      const hits = sweepForUnlisted(root, "canonical", [], {});
      assert.deepEqual(hits.sort(), [
        join("rogue", "0042_four_digit.sql"),
        join("rogue", "20270615_eight_digit_dated.sql"),
      ].sort());
    } finally {
      cleanup();
    }
  });

  it("does NOT flag a near-miss filename that isn't actually migration-shaped", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      // Hyphen instead of underscore, and no digits at all — both real
      // examples found in the repo (2080-rollback.sql, migration.sql).
      write(root, "misc/2080-rollback.sql", "not a migration");
      write(root, "misc/migration.sql", "not a migration either");
      const hits = sweepForUnlisted(root, "canonical", [], {});
      assert.deepEqual(hits, []);
    } finally {
      cleanup();
    }
  });
});

describe("ALLOWLISTED_ROOTS — exempted by name, not by weakening the sweep", () => {
  it("an allowlisted root's migration-shaped files are NOT flagged by the sweep", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "review-staging/2100_proposal.sql", "proposal");
      const allowlisted = [{ relPath: "review-staging", label: "L", reason: "test", nonExecutable: false }];
      const hits = sweepForUnlisted(root, "canonical", allowlisted, {});
      assert.deepEqual(hits, []);
    } finally {
      cleanup();
    }
  });

  it("LOAD-BEARING: a DIFFERENT, unlisted root still fails even with an allowlist present", () => {
    // This is the property bug D also protects: allowlisting must be
    // name-specific, never a way to generally relax the sweep. A third,
    // genuinely new/unlisted directory sitting right next to two
    // legitimately-allowlisted ones must still be caught.
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "review-staging/2100_proposal.sql", "proposal");
      write(root, "another-baseline-dir/20260819_baseline_structure.sql", "not allowlisted");
      const allowlisted = [{ relPath: "review-staging", label: "L", reason: "test", nonExecutable: false }];
      const hits = sweepForUnlisted(root, "canonical", allowlisted, {});
      assert.deepEqual(hits, [join("another-baseline-dir", "20260819_baseline_structure.sql")]);
    } finally {
      cleanup();
    }
  });

  it("runFrozenDirCheck: allowlisted roots clear the sweep but FrozenRoots are still hash-pinned as before", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "frozen-root/0001_f.sql", "frozen");
      write(root, "staging/2100_proposal.sql", "proposal");
      const frozenRoots = [
        { relPath: "frozen-root", label: "F", files: { "0001_f.sql": sha256(join(root, "frozen-root/0001_f.sql")) } },
      ];
      const allowlisted = [{ relPath: "staging", label: "S", reason: "test", nonExecutable: false }];
      const result = runFrozenDirCheck(root, "canonical", frozenRoots, {}, allowlisted);
      assert.equal(result.passed, true);
      assert.deepEqual(result.unlistedHits, []);

      // Mutate the FROZEN root — must still be caught; allowlisting a
      // DIFFERENT directory must not have loosened checkRoot's own hash pin.
      write(root, "frozen-root/0001_f.sql", "frozen, but tampered");
      const result2 = runFrozenDirCheck(root, "canonical", frozenRoots, {}, allowlisted);
      assert.equal(result2.passed, false);
      assert.deepEqual(result2.rootDiffs[0].modified, ["0001_f.sql"]);
    } finally {
      cleanup();
    }
  });
});

describe("checkNonExecutableOverlap — a non-executable artifact must never match a canonical migration", () => {
  it("flags a FILENAME collision between a nonExecutable root and the canonical dir", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/2100_something.sql", "the real migration");
      write(root, "baseline/2100_something.sql", "a baseline file that happens to share a name");
      const nonExec = [{ relPath: "baseline", nonExecutable: true }];
      const violations = checkNonExecutableOverlap(root, "canonical", nonExec);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].kind, "same-filename");
      assert.equal(violations[0].relPath, join("baseline", "2100_something.sql"));
    } finally {
      cleanup();
    }
  });

  it("flags a CONTENT collision even with different filenames — a copy renamed to dodge the filename check", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/2100_real.sql", "IDENTICAL BYTES");
      write(root, "baseline/20260819_dump.sql", "IDENTICAL BYTES");
      const nonExec = [{ relPath: "baseline", nonExecutable: true }];
      const violations = checkNonExecutableOverlap(root, "canonical", nonExec);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].kind, "identical-content");
    } finally {
      cleanup();
    }
  });

  it("does NOT flag a review-staging root (nonExecutable: false) — overlap there is the intended end state", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/2100_something.sql", "applied");
      write(root, "staging/2100_something.sql", "the proposal that was applied verbatim");
      const notNonExec = [{ relPath: "staging", nonExecutable: false }];
      const violations = checkNonExecutableOverlap(root, "canonical", notNonExec);
      assert.deepEqual(violations, []);
    } finally {
      cleanup();
    }
  });

  it("clean baseline (no overlap) reports no violations", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/2100_something.sql", "the real migration");
      write(root, "baseline/20260819_baseline_structure.sql", "completely different, unrelated dump content");
      const nonExec = [{ relPath: "baseline", nonExecutable: true }];
      const violations = checkNonExecutableOverlap(root, "canonical", nonExec);
      assert.deepEqual(violations, []);
    } finally {
      cleanup();
    }
  });
});

describe("real-repo integration — the actual consolidated tree passes end-to-end", () => {
  it("runFrozenDirCheck against the real repo, real manifest, passes clean", () => {
    // Mirrors checkFrozenDir.ts's own path resolution exactly (this test
    // file lives at src/test/, one level shallower than src/scripts/, so
    // the same "../../../.." from scripts becomes "../../.." from test).
    const __dir = dirname(fileURLToPath(import.meta.url));
    const REPO_ROOT = resolve(__dir, "../../../..");
    const CANONICAL_REL = "artifacts/api-server/src/migrations";
    const result = runFrozenDirCheck(REPO_ROOT, CANONICAL_REL, FROZEN_ROOTS, FROZEN_LOOSE_FILES, ALLOWLISTED_ROOTS);
    assert.equal(
      result.passed,
      true,
      `real-repo check failed — rootDiffs: ${JSON.stringify(result.rootDiffs.filter((d) => d.added.length || d.removed.length || d.modified.length || d.missingDirEntirely))}, ` +
        `unlistedHits: ${JSON.stringify(result.unlistedHits)}, nonExecutableOverlaps: ${JSON.stringify(result.nonExecutableOverlaps)}`,
    );
  });

  it("ALLOWLISTED_ROOTS has exactly the two named directories, each with a non-empty reason", () => {
    const relPaths = ALLOWLISTED_ROOTS.map((r) => r.relPath).sort();
    assert.deepEqual(relPaths, ["artifacts/api-server/baseline", "reconciliation-staging"].sort());
    for (const root of ALLOWLISTED_ROOTS) {
      assert.ok(root.reason?.trim(), `${root.relPath} has no reason`);
    }
  });

  it("the baseline root is flagged nonExecutable; the review-staging root is not", () => {
    const byPath = Object.fromEntries(ALLOWLISTED_ROOTS.map((r) => [r.relPath, r.nonExecutable]));
    assert.equal(byPath["artifacts/api-server/baseline"], true);
    assert.equal(byPath["reconciliation-staging"], false);
  });
});

describe("checkLooseFiles", () => {
  it("reports ok / modified / missing correctly", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "keep.sql", "unchanged");
      write(root, "edited.sql", "will be edited");
      const expected = {
        "keep.sql": sha256(join(root, "keep.sql")),
        "edited.sql": sha256(join(root, "edited.sql")),
        "gone.sql": "irrelevant-hash",
      };
      write(root, "edited.sql", "was edited");
      const diffs = checkLooseFiles(root, expected);
      const byPath = Object.fromEntries(diffs.map((d) => [d.relPath, d.status]));
      assert.deepEqual(byPath, { "keep.sql": "ok", "edited.sql": "modified", "gone.sql": "missing" });
    } finally {
      cleanup();
    }
  });
});

describe("runFrozenDirCheck — end-to-end pass/fail", () => {
  it("passed: true when every root, loose file, and the sweep are all clean", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "known-root/0001_k.sql", "known");
      write(root, "loose.sql", "pinned");
      const roots = [{ relPath: "known-root", label: "K", files: { "0001_k.sql": sha256(join(root, "known-root/0001_k.sql")) } }];
      const looseFiles = { "loose.sql": sha256(join(root, "loose.sql")) };
      const result = runFrozenDirCheck(root, "canonical", roots, looseFiles);
      assert.equal(result.passed, true);
    } finally {
      cleanup();
    }
  });

  it("passed: false when any single one of root/loose/sweep fails", () => {
    const { root, cleanup } = makeTempRepo();
    try {
      write(root, "canonical/0001_c.sql", "canon");
      write(root, "known-root/0001_k.sql", "known");
      write(root, "loose.sql", "pinned");
      write(root, "unlisted-dir/9999_rogue.sql", "rogue");
      const roots = [{ relPath: "known-root", label: "K", files: { "0001_k.sql": sha256(join(root, "known-root/0001_k.sql")) } }];
      const looseFiles = { "loose.sql": sha256(join(root, "loose.sql")) };
      const result = runFrozenDirCheck(root, "canonical", roots, looseFiles);
      assert.equal(result.passed, false);
      assert.deepEqual(result.unlistedHits, [join("unlisted-dir", "9999_rogue.sql")]);
    } finally {
      cleanup();
    }
  });
});
