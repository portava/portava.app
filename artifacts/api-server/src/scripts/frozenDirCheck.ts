/**
 * Frozen-dir guard — core, testable logic.
 *
 * Pulled out of checkFrozenDir.ts (which just resolves the real repo root and
 * the real manifest, calls run(), prints, and exits) so tests can call these
 * functions against a temp directory instead of exercising the actual repo
 * tree and instead of shelling out to a process.exit()-calling script.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import type { FrozenRoot } from "./frozenMigrationRoots.js";

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface RootDiff {
  label: string;
  relPath: string;
  missingDirEntirely: boolean;
  added: string[];
  removed: string[];
  modified: string[];
}

/**
 * Diff one frozen root's actual on-disk state against its manifest.
 *
 * Fixes three of the four original bugs:
 *   - content is hashed and compared, not just filenames (was modification-blind)
 *   - a directory that's vanished entirely is reported as every known file
 *     being deleted, not silently treated as passing
 *   - every expected filename is checked for presence, not just scanned
 *     entries checked for membership (was deletion-blind — could only ever
 *     detect additions, never removals)
 */
export function checkRoot(repoRoot: string, relPath: string, label: string, expected: Record<string, string>): RootDiff {
  const absPath = resolve(repoRoot, relPath);
  const diff: RootDiff = {
    label, relPath, missingDirEntirely: false, added: [], removed: [], modified: [],
  };

  let entries: string[];
  try {
    entries = (readdirSync(absPath, { recursive: true }) as string[]).filter((f) =>
      f.toLowerCase().endsWith(".sql"),
    );
  } catch {
    if (Object.keys(expected).length > 0) {
      diff.missingDirEntirely = true;
      diff.removed = Object.keys(expected).sort();
    }
    return diff;
  }

  const actualHashes = new Map<string, string>();
  for (const f of entries) {
    actualHashes.set(f, sha256(join(absPath, f)));
  }

  for (const f of actualHashes.keys()) {
    if (!(f in expected)) diff.added.push(f);
  }
  for (const f of Object.keys(expected)) {
    if (!actualHashes.has(f)) {
      diff.removed.push(f);
      continue;
    }
    if (actualHashes.get(f) !== expected[f]) diff.modified.push(f);
  }

  diff.added.sort();
  diff.removed.sort();
  diff.modified.sort();
  return diff;
}

export interface LooseDiff { relPath: string; status: "ok" | "missing" | "modified" }

export function checkLooseFiles(repoRoot: string, looseFiles: Record<string, string>): LooseDiff[] {
  return Object.entries(looseFiles).map(([relPath, expectedHash]) => {
    const absPath = resolve(repoRoot, relPath);
    try {
      const actual = sha256(absPath);
      return { relPath, status: actual === expectedHash ? "ok" : "modified" } as LooseDiff;
    } catch {
      return { relPath, status: "missing" } as LooseDiff;
    }
  });
}

/** Directory names never descended into during the unlisted-root sweep. */
export const DEFAULT_SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".cache", ".local", "dist", "build", ".next",
  "coverage", ".replit", ".config", "android", "ios", "vendor",
]);

// 4-digit (e.g. 0011_, 2079_) or 8-digit dated (e.g. 20260815_) numeric-prefix
// convention. Anchored lengths, not `\d+`, so an unrelated file that merely
// starts with digits (e.g. "2080-rollback.sql" — hyphen, not underscore, and
// "migration.sql" with no digits at all) is correctly not migration-shaped.
export const MIGRATION_SHAPED_RE = /^(\d{4}|\d{8})_.+\.sql$/i;

/**
 * Walk `repoRoot` looking for migration-shaped .sql filenames outside the
 * canonical dir and every known frozen root / loose-file entry. Fixes the
 * fourth original bug (two hardcoded paths, no way to add a third without
 * duplicating the whole check) by taking the root list as data, and adds the
 * new requirement: an unlisted root must fail the build, not pass silently.
 */
export function sweepForUnlisted(
  repoRoot: string,
  canonicalRel: string,
  roots: Pick<FrozenRoot, "relPath">[],
  looseFiles: Record<string, string>,
  skipDirNames: Set<string> = DEFAULT_SKIP_DIR_NAMES,
): string[] {
  const canonicalAbsPath = resolve(repoRoot, canonicalRel);
  const knownRootAbsPaths = roots.map((r) => resolve(repoRoot, r.relPath));
  const knownLooseAbsPaths = new Set(Object.keys(looseFiles).map((p) => resolve(repoRoot, p)));

  function isUnderKnownRoot(absFilePath: string): boolean {
    const dir = dirname(absFilePath);
    if (dir === canonicalAbsPath) return true;
    if (knownRootAbsPaths.includes(dir)) return true;
    if (knownLooseAbsPaths.has(absFilePath)) return true;
    return false;
  }

  const unlistedHits: string[] = [];

  function sweep(dirAbs: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skipDirNames.has(name)) continue;
      const abs = join(dirAbs, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        sweep(abs);
      } else if (st.isFile() && MIGRATION_SHAPED_RE.test(name)) {
        if (!isUnderKnownRoot(abs)) {
          unlistedHits.push(relative(repoRoot, abs));
        }
      }
    }
  }

  sweep(repoRoot);
  unlistedHits.sort();
  return unlistedHits;
}

export interface FrozenDirCheckResult {
  rootDiffs: RootDiff[];
  looseDiffs: LooseDiff[];
  unlistedHits: string[];
  passed: boolean;
}

export function runFrozenDirCheck(
  repoRoot: string,
  canonicalRel: string,
  roots: FrozenRoot[],
  looseFiles: Record<string, string>,
  skipDirNames?: Set<string>,
): FrozenDirCheckResult {
  const rootDiffs = roots.map((r) => checkRoot(repoRoot, r.relPath, r.label, r.files));
  const looseDiffs = checkLooseFiles(repoRoot, looseFiles);
  const unlistedHits = sweepForUnlisted(repoRoot, canonicalRel, roots, looseFiles, skipDirNames);

  const rootsOk = rootDiffs.every(
    (d) => !d.missingDirEntirely && d.added.length === 0 && d.removed.length === 0 && d.modified.length === 0,
  );
  const looseOk = looseDiffs.every((d) => d.status === "ok");
  const passed = rootsOk && looseOk && unlistedHits.length === 0;

  return { rootDiffs, looseDiffs, unlistedHits, passed };
}
