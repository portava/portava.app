/**
 * cross-tree-helpers-style-broken.ts
 *
 * Guard input (NOT a guard target): used by the cross-tree-paths unit tests to
 * verify that a helper file of the kind placed inside a `__helpers__`,
 * `__testUtils__`, or `__support__` directory — with a broken cross-tree
 * readFileSync path — is detected and reported rather than silently skipped.
 *
 * The path below is intentionally wrong — this file does NOT exist.
 */
import fs from 'node:fs';
import path from 'node:path';

const __dir = path.dirname(new URL(import.meta.url).pathname);

// Intentionally broken: this-helpers-style-file-does-not-exist.json does not exist.
const _data = fs.readFileSync(`${__dir}/../../this-helpers-style-file-does-not-exist.json`, 'utf8');
export default _data;
