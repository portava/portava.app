/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify that the guard emits an
 * "unresolvable" warning when readFileSync receives a plain variable instead
 * of a static string or template literal.
 */
import fs from 'node:fs';

// A plain-variable argument — the guard cannot statically resolve this.
const crossTreePath = '../../../some/path.json';
const _content = fs.readFileSync(crossTreePath, 'utf8');
void _content;
