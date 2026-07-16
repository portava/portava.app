/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify that the guard can trace a
 * variable assigned from a multi-segment path.resolve(...) call and confirm
 * the resolved path actually exists.
 *
 * Chain:
 *   here     = import.meta.dirname                  (fixture dir)
 *   pkgRoot  = path.resolve(here, '../..')           (scripts/ dir)
 *   pkgPath  = path.resolve(pkgRoot, 'package.json') (scripts/package.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '../..');
const pkgPath = path.resolve(pkgRoot, 'package.json');

const _content = fs.readFileSync(pkgPath, 'utf8');
void _content;
