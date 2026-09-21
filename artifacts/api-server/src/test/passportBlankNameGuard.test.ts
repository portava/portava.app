/**
 * The universal display-name rule refuses a BLANK name — everywhere.
 *
 * FOUND BY census-compass CP-02 (2026-09-20). `lib/publicIdentity.presentedName`
 * is the canonical rule and it rejects a whitespace-only name:
 *   `typeof n === "string" && n.trim().length > 0 ? n : null`
 * but `PassportProjectionService.buildIdentity` composed its own chain,
 * `named.display_name ?? named.name ?? null`, with NO blank check. A subject
 * whose `display_name` is "   " therefore came back from every consumer variant
 * (discovery_card included) carrying a name made of spaces — which renders as a
 * nameless person rather than as the handle fallback the rule intends.
 *
 * CP-02 guards it at the point of consumption in routes/compass.ts. This suite
 * pins it at the SOURCE, so every other consumer of the projection gets it too.
 *
 * TEST-FIRST: written before the fix and watched fail — `name` came back as
 * "   " for the blank-name subject.
 *
 * Mutation log (each applied alone, suite re-run, source restored):
 *   M1 buildIdentity's blank check removed (back to `?? named.name ?? null`) → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/passportBlankNameGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { presentedName } from "../lib/publicIdentity.js";

describe("blank names are refused by the canonical rule", () => {
  it("presentedName refuses whitespace-only, and keeps a real name", () => {
    assert.equal(presentedName({ display_name: "   " } as any, true), null);
    assert.equal(presentedName({ display_name: "\t\n " } as any, true), null);
    assert.equal(presentedName({ display_name: "", name: "  " } as any, true), null);
    assert.equal(presentedName({ display_name: "Ana" } as any, true), "Ana");
    assert.equal(presentedName({ display_name: null, name: "Bo" } as any, true), "Bo");
  });

  it("buildIdentity composes the canonical rule rather than its own ?? chain", () => {
    const src = readFileSync(new URL("../services/passport/PassportProjectionService.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // The private copy is the defect. It must not be what feeds `name:`.
    assert.doesNotMatch(
      src,
      /name:\s*named\.display_name\s*\?\?\s*named\.name\s*\?\?\s*null/,
      "buildIdentity must not rebuild the display-name rule with its own ?? chain — it drops the blank check",
    );
    assert.match(src, /presentedName\(/, "buildIdentity must compose lib/publicIdentity.presentedName");
  });
});
