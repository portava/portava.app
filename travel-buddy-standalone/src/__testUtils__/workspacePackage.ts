/**
 * workspacePackage.ts
 *
 * Reads the workspace-root package.json at import time and re-exports
 * the fields that standalone tests care about (name, version).
 *
 * Why cross-tree?  The standalone tree lives at
 *   travel-buddy-standalone/src/__testUtils__/          ← this file
 * and the workspace root lives three levels up:
 *   ../../../package.json
 *
 * Having a real readFileSync call here also validates the live-scan leg
 * of cross-tree-paths.test.ts — it confirms that __testUtils__ helper
 * files are discovered and their paths resolved end-to-end.
 */

import { readFileSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

/** Raw parsed workspace-root package.json. */
const _raw = JSON.parse(
  readFileSync(pathResolve(__dir, '../../../package.json'), 'utf8'),
) as Record<string, unknown>;

/** The workspace root package name (e.g. "travel-buddy-workspace"). */
export const WORKSPACE_NAME: string = typeof _raw['name'] === 'string' ? _raw['name'] : '';

/** The workspace root package version string (e.g. "0.0.0"). */
export const WORKSPACE_VERSION: string =
  typeof _raw['version'] === 'string' ? _raw['version'] : '';
