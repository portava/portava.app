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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRoot,
  checkLooseFiles,
  sweepForUnlisted,
  runFrozenDirCheck,
  sha256,
} from "../scripts/frozenDirCheck.js";

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
