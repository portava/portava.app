/**
 * Style-version sync guard.
 *
 * CURRENT_STYLE_VERSION in the mobile admin service
 * (travel-buddy-standalone/src/services/adminStamps.ts) is a manually
 * maintained copy of STYLE_VERSION from the API server
 * (artifacts/api-server/src/lib/stamps/artDirection.ts).
 *
 * WHICH APP TREE. This pointed at artifacts/travel-buddy — the FROZEN LEGACY
 * tree — until that tree was archived. Both trees held byte-identical copies
 * ("v1.0"), so the guard passed either way and the mistake was invisible; but
 * it made the check worthless in the case it exists for. Bumping the LIVE
 * tree's constant would not have been noticed, and the guard would have gone
 * on vouching for a file that is not shipped. It now reads the live tree.
 * (Same class of defect, and same correction, as APP_TREE_ROOT in
 * artifacts/api-server/scripts/check-flag-polarity.mjs.)
 *
 * If either is bumped without bumping the other the stale-style badge
 * silently stops working: reviewers see no warning even though the artwork
 * is outdated.
 *
 * This test asserts both constants are identical so a mis-matched bump is
 * caught on every test run instead of being discovered in production.
 *
 * Run: node --import tsx/esm --test src/test/styleVersionSync.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STYLE_VERSION } from "../lib/stamps/artDirection.js";

// ── Locate and read the mobile service file ───────────────────────────────────

// __dirname is not available in ESM; derive the repo root from import.meta.url.
const repoRoot = new URL("../../../../", import.meta.url).pathname;
const mobileServicePath = resolve(
  repoRoot,
  "travel-buddy-standalone/src/services/adminStamps.ts",
);

const mobileSource = readFileSync(mobileServicePath, "utf-8");

/**
 * Extract the value of CURRENT_STYLE_VERSION from the mobile source file.
 * Matches both single-quoted and double-quoted string literals, e.g.:
 *   export const CURRENT_STYLE_VERSION = "v1.0";
 *   export const CURRENT_STYLE_VERSION = 'v1.0';
 */
function extractMobileStyleVersion(source: string): string | null {
  const match = source.match(
    /export\s+const\s+CURRENT_STYLE_VERSION\s*=\s*["']([^"']+)["']/,
  );
  return match ? match[1] : null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("STYLE_VERSION sync — API server ↔ mobile admin service", () => {
  it("mobile adminStamps.ts declares CURRENT_STYLE_VERSION", () => {
    const mobileVersion = extractMobileStyleVersion(mobileSource);
    assert.ok(
      mobileVersion !== null,
      "Could not find CURRENT_STYLE_VERSION in travel-buddy-standalone/src/services/adminStamps.ts. " +
        "The constant must be declared as:\n" +
        '  export const CURRENT_STYLE_VERSION = "<version>";',
    );
  });

  it("CURRENT_STYLE_VERSION matches STYLE_VERSION — bump both together", () => {
    const mobileVersion = extractMobileStyleVersion(mobileSource);
    assert.equal(
      mobileVersion,
      STYLE_VERSION,
      `Version mismatch detected!\n` +
        `  API server  STYLE_VERSION         = "${STYLE_VERSION}"\n` +
        `  Mobile      CURRENT_STYLE_VERSION  = "${mobileVersion}"\n\n` +
        `When bumping STYLE_VERSION in artifacts/api-server/src/lib/stamps/artDirection.ts\n` +
        `also bump CURRENT_STYLE_VERSION in travel-buddy-standalone/src/services/adminStamps.ts\n` +
        `(and vice-versa) so the stale-style badge on the admin review screen stays accurate.`,
    );
  });
});
