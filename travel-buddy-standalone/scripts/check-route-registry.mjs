#!/usr/bin/env node
/**
 * check-route-registry.mjs
 *
 * Compares every *.tsx screen file under app/ against the `path` values
 * registered in src/navigation/portavaRoutes.ts (PORTAVA_ROUTES), and
 * compares every _layout.tsx file against the layout paths registered in
 * PORTAVA_LAYOUT_FILES in the same file.
 *
 * Exits 1 if any screen file is absent from PORTAVA_ROUTES, or if any
 * _layout.tsx is absent from PORTAVA_LAYOUT_FILES, so the check can run in
 * CI and catch registry drift before it ships.
 *
 * Intentional exclusions from the screen check (not expected in PORTAVA_ROUTES):
 *   - Files anywhere inside __tests__/ directories
 *   - Layout files (_layout.tsx)  ← these are checked separately below
 *   - +not-found.tsx
 *   - Platform-specific siblings (*.web.tsx, *.native.tsx, *.ios.tsx, *.android.tsx)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import process from 'node:process';

const APP_DIR = 'app';
const ROUTES_FILE = 'src/navigation/portavaRoutes.ts';

/** Platform-specific suffixes that are siblings of a canonical route, not new routes. */
const PLATFORM_SUFFIXES = ['.web.tsx', '.native.tsx', '.ios.tsx', '.android.tsx'];

// ── Collect app route files ────────────────────────────────────────────────

/**
 * Recursively collect .tsx files under `dir`, skipping __tests__ directories.
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
function collectRouteFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory doesn't exist — skip silently
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue; // skip test directories
      collectRouteFiles(full, out);
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Convert an absolute file path to the Expo-Router path key used in portavaRoutes.ts.
 * e.g. "app/(tabs)/index.tsx" → "(tabs)/index"
 * @param {string} filePath
 * @returns {string}
 */
function toRoutePath(filePath) {
  return relative(APP_DIR, filePath).replace(/\.tsx$/, '');
}

const allFiles = collectRouteFiles(APP_DIR);

// ── Screen files (not layouts) ─────────────────────────────────────────────

const routeFilePaths = allFiles
  .filter((f) => {
    const name = basename(f);
    // Belt-and-suspenders: skip anything inside a __tests__ dir
    if (f.includes('__tests__')) return false;
    // Skip layout files — checked separately below
    if (name === '_layout.tsx') return false;
    // Skip the 404 catch-all (deliberately excluded from the registry or registered as '+not-found')
    if (name === '+not-found.tsx') return false;
    // Skip platform-specific siblings — these are not separate routes
    if (PLATFORM_SUFFIXES.some((s) => name.endsWith(s))) return false;
    return true;
  })
  .map(toRoutePath)
  .sort();

// ── Layout files ───────────────────────────────────────────────────────────

const layoutFilePaths = allFiles
  .filter((f) => {
    if (f.includes('__tests__')) return false;
    return basename(f) === '_layout.tsx';
  })
  .map(toRoutePath)
  .sort();

// ── Extract registered paths from portavaRoutes.ts (text scan) ────────────

let routesSrc;
try {
  routesSrc = readFileSync(ROUTES_FILE, 'utf8');
} catch {
  console.error(`check-route-registry — could not read ${ROUTES_FILE}`);
  process.exit(1);
}

// Match:  path: 'some/path'  or  path: "some/path"
const PATH_RE = /\bpath:\s*['"]([^'"]+)['"]/g;

const registeredPaths = new Set();
let m;
while ((m = PATH_RE.exec(routesSrc)) !== null) {
  registeredPaths.add(m[1]);
}

// ── Compare screens ────────────────────────────────────────────────────────

const missingScreens = routeFilePaths.filter((p) => !registeredPaths.has(p));

// ── Compare layouts ────────────────────────────────────────────────────────

const missingLayouts = layoutFilePaths.filter((p) => !registeredPaths.has(p));

// ── Report ─────────────────────────────────────────────────────────────────

let failed = false;

if (missingScreens.length > 0) {
  console.error(
    `\nRoute registry drift — ${missingScreens.length} screen file(s) not found in PORTAVA_ROUTES:\n\n` +
      missingScreens.map((p) => `  app/${p}.tsx  →  add path: '${p}'`).join('\n') +
      '\n\nAdd a matching entry to src/navigation/portavaRoutes.ts for each missing route.\n' +
      'See docs/navigation/PORTAVA_UI_AUDIT.md for field conventions.\n',
  );
  failed = true;
}

if (missingLayouts.length > 0) {
  console.error(
    `\nLayout registry drift — ${missingLayouts.length} layout file(s) not found in PORTAVA_LAYOUT_FILES:\n\n` +
      missingLayouts.map((p) => `  app/${p}.tsx  →  add path: '${p}'`).join('\n') +
      '\n\nAdd a matching entry to the PORTAVA_LAYOUT_FILES array in\n' +
      'src/navigation/portavaRoutes.ts for each missing layout.\n' +
      'See docs/navigation/PORTAVA_UI_AUDIT.md §10 for field conventions.\n',
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(
  `check-route-registry — OK. ` +
    `All ${routeFilePaths.length} screen file(s) are represented in PORTAVA_ROUTES and ` +
    `all ${layoutFilePaths.length} layout file(s) are represented in PORTAVA_LAYOUT_FILES.`,
);
