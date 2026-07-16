/**
 * FIXTURE — do not run directly.
 * Used by cross-tree-paths.test.ts to verify template-literal path detection.
 *
 * This file contains a readFileSync call with a template-literal path that
 * uses the ${__dir}/... form.  The path resolves to a real file so the guard
 * should detect it AND confirm it exists.
 */
import fs from 'node:fs';

const __dir = import.meta.dirname;

// Template-literal form: ${__dir}/../../package.json
// Resolves (from scripts/src/__fixtures__/) to scripts/package.json
const _content = fs.readFileSync(`${__dir}/../../package.json`, 'utf8');
void _content;
