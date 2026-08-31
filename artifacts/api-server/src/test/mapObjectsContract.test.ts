/**
 * Map Object contract drift guard (Map spec §18).
 *
 * The contract is declared TWICE — once for the API server
 * (src/lib/mapObjects.ts) and once for the Expo app
 * (travel-buddy-standalone/src/types/mapObjects.ts) — because the two are
 * separate packages with no shared build and no codegen. That duplication is a
 * standing invitation to drift: add a kind on one side, and the other silently
 * stops understanding a value it is being sent.
 *
 * This test is the thing that makes the duplication safe. It reads BOTH files
 * as text and asserts the wire-visible vocabularies are identical, member for
 * member, in order.
 *
 * It reads text rather than importing the app module on purpose: the app file
 * is outside this package's dependency graph and uses the app's own import
 * conventions, so importing it would couple the server's test run to the app's
 * toolchain. Text comparison needs neither.
 *
 * Also asserted here: the server derives CONFIDENCE_STATES from
 * intelContracts.CONFIDENCE_BANDS, so this guard transitively pins the app's
 * copy to the bands the intel pipeline actually computes. A band added to
 * intelContracts fails this test until the app mirror is updated — which is
 * exactly the reminder you want.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIDENCE_BANDS } from "../lib/intelContracts.js";
import {
  ACTIVITY_LEVELS,
  CONFIDENCE_STATES,
  FRESHNESS_STATES,
  KIND_DEFAULT_PRIORITY,
  MAP_ACTIONS,
  MAP_OBJECT_KINDS,
  PRIVACY_CLASSES,
  RENDERING_PRIORITY,
  TREND_STATES,
} from "../lib/mapObjects.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const APP_CONTRACT = resolve(
  __dir,
  "../../../../travel-buddy-standalone/src/types/mapObjects.ts",
);

const appSource = readFileSync(APP_CONTRACT, "utf8");

/** Extract the string members of `export const NAME = [ ... ] as const;`. */
function appStringArray(name: string): string[] {
  const re = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`, "m");
  const m = re.exec(appSource);
  assert.ok(m, `app contract is missing "export const ${name} = [...] as const"`);
  return Array.from(m![1].matchAll(/['"]([^'"]+)['"]/g)).map((x) => x[1]);
}

/** Extract the numeric members of `export const NAME = { key: 123, ... } as const;`. */
function appNumericRecord(name: string): Record<string, number> {
  const re = new RegExp(`export const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\}\\s*as const`, "m");
  const m = re.exec(appSource);
  assert.ok(m, `app contract is missing "export const ${name} = {...} as const"`);
  const out: Record<string, number> = {};
  for (const line of m![1].split("\n")) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?\d+(?:\.\d+)?)\s*,?/.exec(line);
    if (kv) out[kv[1]] = Number(kv[2]);
  }
  return out;
}

/** Extract `export const NAME: Record<...> = { key: EXPR, ... };` as key → expression. */
function appExprRecord(name: string): Record<string, string> {
  const re = new RegExp(`export const ${name}\\s*:[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`, "m");
  const m = re.exec(appSource);
  assert.ok(m, `app contract is missing "export const ${name}: ... = {...};"`);
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,]+),?\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

describe("Map Object contract — server and app mirrors agree", () => {
  test("MAP_OBJECT_KINDS is identical, in order", () => {
    assert.deepEqual(appStringArray("MAP_OBJECT_KINDS"), [...MAP_OBJECT_KINDS]);
  });

  test("FRESHNESS_STATES is identical, in order", () => {
    assert.deepEqual(appStringArray("FRESHNESS_STATES"), [...FRESHNESS_STATES]);
  });

  test("PRIVACY_CLASSES is identical, in order — ordering IS the ladder", () => {
    // precisionRank() is indexOf() on this array, so a reordering silently
    // changes which rung counts as "more private" on one side only.
    assert.deepEqual(appStringArray("PRIVACY_CLASSES"), [...PRIVACY_CLASSES]);
  });

  test("ACTIVITY_LEVELS and TREND_STATES are identical, in order", () => {
    assert.deepEqual(appStringArray("ACTIVITY_LEVELS"), [...ACTIVITY_LEVELS]);
    assert.deepEqual(appStringArray("TREND_STATES"), [...TREND_STATES]);
  });

  test("MAP_ACTIONS is identical, in order", () => {
    assert.deepEqual(appStringArray("MAP_ACTIONS"), [...MAP_ACTIONS]);
  });

  test("CONFIDENCE_STATES matches the intel pipeline's own bands", () => {
    // Server side is derived, so this is really a check on the app mirror.
    assert.deepEqual([...CONFIDENCE_STATES], [...CONFIDENCE_BANDS]);
    assert.deepEqual(appStringArray("CONFIDENCE_STATES"), [...CONFIDENCE_BANDS]);
  });

  test("RENDERING_PRIORITY tiers and values are identical", () => {
    assert.deepEqual(appNumericRecord("RENDERING_PRIORITY"), { ...RENDERING_PRIORITY });
  });

  test("KIND_DEFAULT_PRIORITY covers every kind on both sides, with equal tiers", () => {
    const appMap = appExprRecord("KIND_DEFAULT_PRIORITY");
    assert.deepEqual(
      Object.keys(appMap).sort(),
      Object.keys(KIND_DEFAULT_PRIORITY).sort(),
      "both mirrors must assign a default priority to exactly the same kinds",
    );
    for (const kind of MAP_OBJECT_KINDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(appMap, kind),
        `app KIND_DEFAULT_PRIORITY is missing "${kind}"`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(KIND_DEFAULT_PRIORITY, kind),
        `server KIND_DEFAULT_PRIORITY is missing "${kind}"`,
      );
      // The app writes RENDERING_PRIORITY.<tier>; resolve it and compare values.
      const tier = appMap[kind].replace("RENDERING_PRIORITY.", "");
      assert.ok(
        tier in RENDERING_PRIORITY,
        `app maps "${kind}" to unknown tier "${appMap[kind]}"`,
      );
      assert.equal(
        RENDERING_PRIORITY[tier as keyof typeof RENDERING_PRIORITY],
        KIND_DEFAULT_PRIORITY[kind],
        `"${kind}" has a different default priority on each side`,
      );
    }
  });
});

describe("contract invariants that must hold on the server side", () => {
  test("every kind has a default priority", () => {
    for (const kind of MAP_OBJECT_KINDS) {
      assert.equal(
        typeof KIND_DEFAULT_PRIORITY[kind],
        "number",
        `kind "${kind}" has no default rendering priority`,
      );
    }
  });

  test("safety outranks every other tier", () => {
    const others = Object.entries(RENDERING_PRIORITY).filter(([k]) => k !== "safety");
    for (const [tier, value] of others) {
      assert.ok(
        RENDERING_PRIORITY.safety > value,
        `spec §5: safety must outrank "${tier}"`,
      );
    }
  });

  test("'none' is the least-precise privacy rung", () => {
    assert.equal(PRIVACY_CLASSES[0], "none");
  });
});
