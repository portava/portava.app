/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify that the guard catches a
 * template-literal path pointing at a file that does NOT exist.
 */
import fs from 'node:fs';

const __dir = import.meta.dirname;

// Template-literal form with a non-existent target.
// Resolves to scripts/this-file-does-not-exist.json — expected to be missing.
const _content = fs.readFileSync(`${__dir}/../../this-file-does-not-exist.json`, 'utf8');
void _content;
