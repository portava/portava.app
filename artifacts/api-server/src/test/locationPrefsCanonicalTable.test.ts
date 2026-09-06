/**
 * locationPrefsCanonicalTable.test.ts
 *
 * THE DEFECT
 * ----------
 * The schema carries TWO near-identical base tables for one concept:
 *
 *   location_preferences        — what PATCH /api/me/location-preferences upserts,
 *                                 and what five other readers use.
 *   user_location_preferences   — an un-retired duplicate with NO WRITER anywhere:
 *                                 not server TS, not client TS, not SQL.
 *
 * `LocationPermissionService.loadPreferences` and `CompassProfileService` read the
 * SECOND one. Since nothing writes it, `maybeSingle()` returned null for every
 * user in every environment, and loadPreferences fell back to DEFAULT_PREFS —
 * which are permissive: `location_mode: "city_only"`, `sharing_paused: false`.
 *
 * So `isSharingActive()` was true for a user who had turned sharing OFF, and
 * PulseGeoTagService therefore skipped the `no_location` stub and geo-tagged the
 * post anyway. The user's opt-out was stored correctly by the settings route and
 * then ignored by the code that enforces it. Nothing errored and nothing logged:
 * an empty table and an absent row are the same value to `maybeSingle()`.
 *
 * WHY THE SUITE WAS GREEN
 * -----------------------
 * `pulseGps.test.ts`'s fake client answered preference reads for
 * `user_location_preferences` — the same wrong table the production code read.
 * Fixture and code agreed on a table no user's settings can reach, which is this
 * repo's documented "a fixture written from a fiction pins the fiction" shape.
 * Repointing the reader alone turned 11 of those tests RED, which is what proves
 * the change is load-bearing rather than cosmetic.
 *
 * These tests pin the fix at the level that matters: the canonical table is the
 * one consulted, and an opt-out actually suppresses location.
 *
 * Run: node --import tsx/esm --test src/test/locationPrefsCanonicalTable.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadPreferences,
  isSharingActive,
  effectivePulseVisibility,
} from "../services/location/LocationPermissionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/**
 * A client that answers ONLY for `location_preferences` and returns nothing for
 * the orphan — exactly production's shape, where the orphan has no writer.
 */
function dbWithCanonicalRow(row: Record<string, unknown> | null) {
  const served: string[] = [];
  const client: any = {
    from(table: string) {
      served.push(table);
      const self: any = {
        select: () => self,
        eq: () => self,
        maybeSingle: async () =>
          table === "location_preferences"
            ? { data: row, error: null }
            : { data: null, error: null },
      };
      return self;
    },
  };
  return { client, served };
}

describe("loadPreferences reads the table the settings route actually writes", () => {
  it("consults location_preferences, never the writerless duplicate", async () => {
    const { client, served } = dbWithCanonicalRow({
      user_id: "u1", location_mode: "off", sharing_paused: true,
      pulse_visibility: null, discovery_visibility: null,
      safe_return_enabled: true, trusted_circle_share: false, hotel_blur_enabled: true,
    });
    await loadPreferences(client, "u1");
    assert.ok(
      served.includes("location_preferences"),
      "must read the canonical table that PATCH /api/me/location-preferences upserts",
    );
    assert.ok(
      !served.includes("user_location_preferences"),
      "must NOT read the duplicate — it has no writer, so every read yields null and " +
        "loadPreferences silently degrades to permissive DEFAULT_PREFS",
    );
  });

  it("HONOURS an explicit opt-out instead of falling back to permissive defaults", async () => {
    const { client } = dbWithCanonicalRow({
      user_id: "u1", location_mode: "off", sharing_paused: true,
      pulse_visibility: null, discovery_visibility: null,
      safe_return_enabled: true, trusted_circle_share: false, hotel_blur_enabled: true,
    });
    const prefs = await loadPreferences(client, "u1");

    assert.equal(prefs.sharingPaused, true, "the stored pause must survive the read");
    assert.equal(prefs.locationMode, "off", "the stored mode must survive the read");
    assert.equal(
      isSharingActive(prefs), false,
      "PulseGeoTagService gates the no_location stub on this. When the reader was on " +
        "the writerless table it saw DEFAULT_PREFS (city_only, not paused), concluded " +
        "sharing was ACTIVE for a user who had turned it off, and geo-tagged the post.",
    );
    assert.equal(
      effectivePulseVisibility(prefs), "no_location",
      "a paused user's post must carry no discoverable location",
    );
  });

  it("still degrades to defaults when the user genuinely has no row", async () => {
    const { client } = dbWithCanonicalRow(null);
    const prefs = await loadPreferences(client, "u-new");
    assert.equal(prefs.locationMode, "city_only", "a brand-new user keeps the documented default");
    assert.equal(prefs.sharingPaused, false);
  });
});

describe("no reader drifts back to the writerless duplicate", () => {
  // Source-level, because no fixture can catch this: a fake client answering for
  // the wrong table looks exactly like a real one answering for the right table.
  const FILES = [
    "services/location/LocationPermissionService.ts",
    "compass/CompassProfileService.ts",
  ];

  for (const rel of FILES) {
    it(`${rel} does not query user_location_preferences`, () => {
      const src = readFileSync(resolve(SRC, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      assert.ok(
        !/\.from\(\s*["']user_location_preferences["']\s*\)/.test(src),
        `${rel} reads user_location_preferences again. Nothing writes that table, so the ` +
          `read returns null for every user and the caller degrades to permissive ` +
          `defaults — silently. That is how a stored location opt-out came to be ignored.`,
      );
    });
  }
});
