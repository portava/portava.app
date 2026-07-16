/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify that the guard can trace a
 * variable assigned from a bare resolve(...) call (imported directly from
 * 'node:path' as `import { resolve } from 'node:path'`) and confirm the
 * resolved path actually exists.
 *
 * Chain:
 *   here     = import.meta.dirname                  (fixture dir)
 *   pkgRoot  = resolve(here, '../..')               (scripts/ dir)
 *   pkgPath  = resolve(pkgRoot, 'package.json')     (scripts/package.json)
 */
import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../..');
const pkgPath = resolve(pkgRoot, 'package.json');

const _content = fs.readFileSync(pkgPath, 'utf8');
void _content;
