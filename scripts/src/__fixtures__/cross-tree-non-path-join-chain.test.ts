/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify that the guard correctly flags
 * `pkg` as UNRESOLVABLE when an intermediate variable in the chain (`root`)
 * was produced by a non-path join() call.
 *
 * Chain:
 *   const root = join('...')              ← join from a non-path package
 *   const pkg  = path.resolve(root, 'package.json')
 *   fs.readFileSync(pkg, 'utf8')
 *
 * Because `root` is not a filesystem path, the guard cannot verify `pkg`.
 * It must flag `pkg` as UNRESOLVABLE rather than silently skipping it.
 */
import fs from 'node:fs';
import path from 'node:path';

// `join` imported from a non-path package — NOT 'node:path'.
// The guard must NOT treat this as a path-computing call.
import { join } from 'some-array-lib';

const root = join('../../../');
const pkg = path.resolve(root, 'package.json');
const _content = fs.readFileSync(pkg, 'utf8');
void _content;
