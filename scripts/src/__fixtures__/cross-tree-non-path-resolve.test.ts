/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify that the guard does NOT suppress
 * the UNRESOLVABLE warning when `resolve` is imported from a non-path package
 * rather than from 'node:path'.
 *
 * Because the `resolve` here has nothing to do with the filesystem, the
 * identifier assigned from it must still be flagged as UNRESOLVABLE.
 */
import fs from 'node:fs';

// `resolve` imported from a promise utility — NOT from 'node:path'.
// The guard must NOT treat this as a path-computing call.
import { resolve } from 'some-promise-lib';

const crossTreePath = resolve('../../../some/path.json');
const _content = fs.readFileSync(crossTreePath, 'utf8');
void _content;
