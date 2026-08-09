#!/usr/bin/env node
/**
 * One-shot migration: replace all hardcoded circular-box sizes in the
 * 5-12px "dot / indicator" range with the new `dot.*` tokens from
 * src/theme/tokens.ts.
 *
 * Run from travel-buddy-standalone/:
 *   node scripts/_migrate-dot-tokens.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
process.chdir(ROOT);

const DRY_RUN = process.argv.includes('--dry-run');

/** dot.TOKEN → pixel value */
const DOT_TOKENS = {
  xxs: 5,
  xs:  6,
  sm:  7,
  md:  8,
  lg:  10,
  xl:  12,
};

/** pixel value → dot.TOKEN name */
const PIXEL_TO_TOKEN = Object.fromEntries(
  Object.entries(DOT_TOKENS).map(([tok, px]) => [px, tok]),
);
const DOT_PIXELS = new Set(Object.keys(PIXEL_TO_TOKEN).map(Number));

/** Files explicitly excluded from migration (particles/animation primitives). */
const EXCLUDED_FILES = new Set([
  'src/components/media/StampItBurst.tsx', // INK_DOTS animation burst particles
  'src/components/AvailabilityCard.tsx',   // 9px intentional one-off
  'src/components/discovery/TravelerMapLayer.tsx', // 11px intentional one-off
]);

function collectFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === '__tests__' || entry.name === '__mocks__')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { collectFiles(full, out); continue; }
    if (['.ts', '.tsx'].includes(extname(entry.name))) {
      if (!entry.name.includes('.test.') && !entry.name.includes('.spec.')) out.push(full);
    }
  }
  return out;
}

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src[i] === '\n') line++;
  return line;
}

/**
 * Collect all replacement sites in a file.
 * Returns array of { wStart, wEnd, hStart, hEnd, brStart, brEnd, n }
 * (w = width match, h = height match, br = borderRadius match)
 * sorted descending by wStart so we can replace back-to-front.
 */
function collectSites(src) {
  const sites = [];

  // Same-line: `width: N, height: N`
  const sameLine = /width:\s*([0-9]+)\s*,\s*height:\s*\1\b/g;
  let m;
  while ((m = sameLine.exec(src)) !== null) {
    const n = parseInt(m[1], 10);
    if (!DOT_PIXELS.has(n)) continue;
    // find borderRadius in the same object
    const closeIdx = src.indexOf('}', m.index);
    const win = closeIdx === -1 ? src.slice(m.index, m.index + 300) : src.slice(m.index, closeIdx);
    const brMatch = win.match(/borderRadius:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!brMatch) continue;
    const br = parseFloat(brMatch[1]);
    if (Math.abs(br - n / 2) > 0.6) continue;

    // Compute exact positions
    // width value span
    const wValStart = m.index + m[0].indexOf(String(n));
    const wValEnd = wValStart + String(n).length;
    // height value: appears after the comma
    const commaIdx = m.index + m[0].indexOf(',', m[0].indexOf(String(n)));
    const hValStart = m.index + m[0].lastIndexOf(String(n));
    const hValEnd = hValStart + String(n).length;
    // borderRadius value
    const brAbsOffset = m.index + win.indexOf(brMatch[0]);
    const brValStart = brAbsOffset + brMatch[0].indexOf(brMatch[1]);
    const brValEnd = brValStart + brMatch[1].length;

    sites.push({ wStart: wValStart, wEnd: wValEnd, hStart: hValStart, hEnd: hValEnd, brStart: brValStart, brEnd: brValEnd, n, multiline: false });
  }

  // Multi-line: `width: N,\n  height: N`
  const multiLine = /width:\s*([0-9]+),\s*\n(\s*)height:\s*\1\b/g;
  while ((m = multiLine.exec(src)) !== null) {
    const n = parseInt(m[1], 10);
    if (!DOT_PIXELS.has(n)) continue;
    // Already handled by same-line? No — same-line requires comma+height on same line.
    // Check borderRadius
    const closeIdx = src.indexOf('}', m.index);
    const win = closeIdx === -1 ? src.slice(m.index, m.index + 300) : src.slice(m.index, closeIdx);
    const brMatch = win.match(/borderRadius:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!brMatch) continue;
    const br = parseFloat(brMatch[1]);
    if (Math.abs(br - n / 2) > 0.6) continue;

    // Check for overlap with already-found same-line sites
    const overlap = sites.some(s => Math.abs(s.wStart - m.index) < 10);
    if (overlap) continue;

    // width value
    const wValStart = m.index + m[0].indexOf(String(n));
    const wValEnd = wValStart + String(n).length;
    // height value (second occurrence of n, after the newline)
    const afterNewline = m.index + m[0].indexOf('\n');
    const hValStart = m.index + m[0].lastIndexOf(String(n));
    const hValEnd = hValStart + String(n).length;
    // borderRadius
    const brAbsOffset = m.index + win.indexOf(brMatch[0]);
    const brValStart = brAbsOffset + brMatch[0].indexOf(brMatch[1]);
    const brValEnd = brValStart + brMatch[1].length;

    sites.push({ wStart: wValStart, wEnd: wValEnd, hStart: hValStart, hEnd: hValEnd, brStart: brValStart, brEnd: brValEnd, n, multiline: true });
  }

  // Sort descending by wStart to replace back-to-front
  sites.sort((a, b) => b.wStart - a.wStart);
  return sites;
}

/**
 * Update the `import { ... } from '...tokens...'` line to include `dot`.
 */
function addDotImport(src) {
  // Match named import from tokens
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*theme\/tokens[^'"]*['"]/;
  const m = src.match(importRe);
  if (!m) return src; // no tokens import — shouldn't happen
  if (m[1].split(',').map(s => s.trim()).includes('dot')) return src; // already present
  // Add `dot` to the import list
  const newImport = m[0].replace(
    m[1],
    m[1].trimEnd().replace(/,?\s*$/, '') + ', dot',
  );
  return src.replace(m[0], newImport);
}

let totalFiles = 0;
let totalSites = 0;

for (const root of ['app', 'src']) {
  for (const file of collectFiles(root)) {
    const rel = relative('.', file).split(sep).join('/');
    if (EXCLUDED_FILES.has(rel)) continue;
    if (rel === 'src/theme/tokens.ts') continue;

    let src = readFileSync(file, 'utf8');
    const sites = collectSites(src);
    if (sites.length === 0) continue;

    // Apply replacements back-to-front (so offsets stay valid)
    let modified = src;
    for (const s of sites) {
      const tok = `dot.${PIXEL_TO_TOKEN[s.n]}`;
      const brReplacement = `${tok} / 2`;

      // Replace borderRadius value first (highest offset among the three)
      if (s.brStart > s.hEnd) {
        modified = modified.slice(0, s.brStart) + brReplacement + modified.slice(s.brEnd);
      }
      // Replace height value
      modified = modified.slice(0, s.hStart) + tok + modified.slice(s.hEnd);
      // Replace width value
      modified = modified.slice(0, s.wStart) + tok + modified.slice(s.wEnd);

      // If borderRadius came before height (unusual), handle it
      if (s.brStart <= s.hEnd) {
        // We need to redo borderRadius since offsets may have shifted
        // In practice borderRadius always comes after width/height in these style objects
        // so this branch shouldn't be hit, but guard it
        const newBrRe = /borderRadius:\s*([0-9]+(?:\.[0-9]+)?)/;
        const closeIdx = modified.indexOf('}', s.wStart);
        const win = closeIdx === -1 ? modified.slice(s.wStart, s.wStart + 300) : modified.slice(s.wStart, closeIdx);
        const brM = win.match(newBrRe);
        if (brM) {
          const absStart = s.wStart + win.indexOf(brM[0]) + brM[0].indexOf(brM[1]);
          const absEnd = absStart + brM[1].length;
          modified = modified.slice(0, absStart) + brReplacement + modified.slice(absEnd);
        }
      }
    }

    // Add dot to import
    modified = addDotImport(modified);

    totalSites += sites.length;
    totalFiles++;

    if (DRY_RUN) {
      console.log(`[DRY] ${rel}: ${sites.map(s => `${s.n}px@line${lineAt(src, s.wStart)}`).join(', ')}`);
    } else {
      writeFileSync(file, modified, 'utf8');
      console.log(`Updated ${rel}: ${sites.length} site(s) (${[...new Set(sites.map(s => s.n))].sort().join(', ')}px)`);
    }
  }
}

console.log(`\n${DRY_RUN ? '[DRY] Would update' : 'Updated'} ${totalFiles} files, ${totalSites} sites total.`);
