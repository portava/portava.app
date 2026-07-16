/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify that the guard catches a
 * multi-segment path.resolve(...) variable whose resolved path does NOT exist.
 *
 * Chain:
 *   here     = import.meta.dirname                              (fixture dir)
 *   pkgRoot  = path.resolve(here, '../..')                      (scripts/ dir)
 *   badPath  = path.resolve(pkgRoot, 'this-file-does-not-exist.json')
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '../..');
const badPath = path.resolve(pkgRoot, 'this-file-does-not-exist.json');

const _content = fs.readFileSync(badPath, 'utf8');
void _content;
