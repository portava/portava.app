/**
 * cross-tree-helper-broken.ts
 *
 * Guard input (NOT a guard target): used by the cross-tree-paths unit tests to
 * verify that a helper file with a broken cross-tree readFileSync path is
 * detected and reported rather than silently skipped.
 *
 * The path below is intentionally wrong — this file does NOT exist.
 */
import fs from 'node:fs';
import path from 'node:path';

const __dir = path.dirname(new URL(import.meta.url).pathname);

// Intentionally broken: this-helper-does-not-exist.json does not exist.
const _data = fs.readFileSync(`${__dir}/../../this-helper-does-not-exist.json`, 'utf8');
export default _data;
