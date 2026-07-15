#!/usr/bin/env tsx
/**
 * guard-expo-router-duplicates.ts
 *
 * Detects Expo Router route files that share the same route stem across
 * multiple extensions.  Extension priority (highest → lowest):
 *   .tsx > .ts > .jsx > .js
 *
 * Normal mode (default):
 *   Exits 1 with a clear list of conflicts so CI fails loudly.
 *
 * Self-heal mode (SELF_HEAL_EXPO_ROUTES=1):
 *   Moves lower-priority duplicates to .route-quarantine/ rather than
 *   deleting them permanently.
 *
 * Usage (from repo root):
 *   pnpm --filter @workspace/scripts run routes:guard
 *   pnpm --filter @workspace/scripts run routes:self-heal
 *
 *   Or with a custom app dir as the first positional arg:
 *   tsx scripts/src/guard-expo-router-duplicates.ts path/to/app
 */

import { readdir, rename, mkdir } from 'node:fs/promises';
import { join, relative, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTE_EXTS = ['.tsx', '.ts', '.jsx', '.js'] as const;
type RouteExt = typeof ROUTE_EXTS[number];

const EXT_PRIORITY: Record<RouteExt, number> = {
  '.tsx': 0,
  '.ts':  1,
  '.jsx': 2,
  '.js':  3,
};

function isRouteExt(ext: string): ext is RouteExt {
  return (ROUTE_EXTS as readonly string[]).includes(ext);
}

async function walkDir(dir: string, files: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, files);
    } else if (entry.isFile() && isRouteExt(extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function sortByPriority(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const pa = EXT_PRIORITY[extname(a) as RouteExt] ?? 99;
    const pb = EXT_PRIORITY[extname(b) as RouteExt] ?? 99;
    return pa - pb;
  });
}

export async function findConflicts(
  appDir: string,
): Promise<Array<{ stem: string; keep: string; dupes: string[] }>> {
  const allFiles = await walkDir(appDir);
  const stemMap = new Map<string, string[]>();

  for (const file of allFiles) {
    const ext = extname(file);
    if (!isRouteExt(ext)) continue;
    const stem = file.slice(0, -ext.length);
    const existing = stemMap.get(stem) ?? [];
    existing.push(file);
    stemMap.set(stem, existing);
  }

  const conflicts: Array<{ stem: string; keep: string; dupes: string[] }> = [];
  for (const [stem, files] of stemMap) {
    if (files.length < 2) continue;
    const sorted = sortByPriority(files);
    conflicts.push({ stem, keep: sorted[0], dupes: sorted.slice(1) });
  }
  return conflicts;
}

async function main(): Promise<void> {
  const scriptUrl = import.meta.url;
  const repoRoot = fileURLToPath(new URL('../..', scriptUrl));
  const appDirArg = process.argv[2];

  const appDir = appDirArg
    ? resolve(appDirArg)
    : join(repoRoot, 'artifacts', 'travel-buddy', 'app');

  const quarantineBase = appDirArg
    ? join(resolve(appDirArg), '..', '.route-quarantine')
    : join(repoRoot, 'artifacts', 'travel-buddy', '.route-quarantine');

  const selfHeal = process.env['SELF_HEAL_EXPO_ROUTES'] === '1';
  const cwd = process.cwd();

  console.log(`\n🔍  Checking Expo Router route files in: ${relative(cwd, appDir)}/`);

  const allFiles = await walkDir(appDir);
  const conflicts = await findConflicts(appDir);

  console.log(`    ${allFiles.length} route file(s) scanned`);

  if (conflicts.length === 0) {
    console.log(`✅  No duplicate route stems — all clear.\n`);
    return;
  }

  console.log(`\n⚠️   Found ${conflicts.length} conflict(s):\n`);

  if (!selfHeal) {
    for (const { keep, dupes } of conflicts) {
      console.log(`  KEEP    : ${relative(cwd, keep)}`);
      for (const d of dupes) {
        console.log(`  CONFLICT: ${relative(cwd, d)}`);
      }
      console.log();
    }
    console.error(
      'Duplicate Expo Router route stems detected.\n' +
      'Run with SELF_HEAL_EXPO_ROUTES=1 to quarantine lower-priority duplicates:\n' +
      '  pnpm --filter @workspace/scripts run routes:self-heal\n',
    );
    process.exit(1);
  }

  // ── Self-heal mode ─────────────────────────────────────────────────────────
  const ts = Date.now();
  let quarantined = 0;

  await mkdir(quarantineBase, { recursive: true });

  for (const { keep, dupes } of conflicts) {
    console.log(`  KEEP      : ${relative(cwd, keep)}`);
    for (const dupe of dupes) {
      const rel = relative(appDir, dupe);
      const dest = join(quarantineBase, `${rel}.${ts}.bak`);
      await mkdir(dirname(dest), { recursive: true });
      await rename(dupe, dest);
      console.log(
        `  QUARANTINE: ${relative(cwd, dupe)}\n` +
        `           → .route-quarantine/${relative(quarantineBase, dest)}`,
      );
      quarantined++;
    }
    console.log();
  }

  console.log(
    `✅  Self-heal complete: ${quarantined} file(s) quarantined, ` +
    `${conflicts.length} conflict(s) resolved.\n`,
  );
}

main().catch((err: unknown) => {
  console.error('guard-expo-router-duplicates:', err);
  process.exit(1);
});
