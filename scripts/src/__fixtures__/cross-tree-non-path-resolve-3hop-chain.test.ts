/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify that the guard correctly flags
 * `pkg` as UNRESOLVABLE when the non-path resolve() sits two hops before
 * readFileSync (a three-hop chain).
 *
 * Chain:
 *   const root = resolve('...')              ← resolve from a non-path package
 *   const mid  = path.resolve(root, 'sub')   ← path.resolve wrapping non-path root
 *   const pkg  = path.resolve(mid, 'package.json')
 *   fs.readFileSync(pkg, 'utf8')
 *
 * Because `root` is not a filesystem path, neither `mid` nor `pkg` can be
 * statically verified.  The guard must flag `pkg` as UNRESOLVABLE rather than
 * silently skipping it.
 */
import fs from 'node:fs';
import path from 'node:path';

// `resolve` imported from a non-path package — NOT 'node:path'.
// The guard must NOT treat this as a path-computing call.
import { resolve } from 'some-promise-lib';

const root = resolve('../../../');
const mid = path.resolve(root, 'sub');
const pkg = path.resolve(mid, 'package.json');
const _content = fs.readFileSync(pkg, 'utf8');
void _content;
