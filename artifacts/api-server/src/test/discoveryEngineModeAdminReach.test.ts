/**
 * Every engine state `01` §8 requires must be SELECTABLE through the product's
 * own admin surface — not merely resolvable by the engine.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * `lib/discoveryEngineMode.ts` grew `compare` and `partial` so that all five
 * states could be resolved. `routes/admin.ts` validated the operator's
 * `metadata.mode` against a SECOND, hand-maintained copy of the list —
 * `["legacy", "shadow", "pde"]` — and was not updated. The result was a
 * capability that existed in the resolver and could not be reached from the
 * shipping product: `PATCH /admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata`
 * with `{"mode":"partial"}` was refused at the edge.
 *
 * It failed CLOSED, so nothing was ever unsafe. That is exactly why it could sit
 * there: a refusal to *set* a new state looks identical to a state nobody has
 * asked for yet. Nothing failed, and two of five requirements were unreachable.
 *
 * ── WHY A TEST AND NOT JUST THE FIX ─────────────────────────────────────────
 * The fix (deriving the admin list from the resolver's own alias map) is one
 * line, and one line is exactly what a future edit re-types by hand when it
 * wants to constrain a different flag. This file asserts the PROPERTY — every
 * accepted spelling round-trips, every state is reachable, and nothing else is
 * admitted — so re-introducing a literal list goes red on the commit that does
 * it rather than being discovered by a census two weeks later.
 *
 * MUTATION: re-type `allowed` in `routes/admin.ts` as any literal array, or drop
 * a spelling from `STATE_ALIASES` without removing its state → red here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCOVERY_ENGINE_STATES,
  ACCEPTED_ENGINE_MODE_SPELLINGS,
  parseEngineState,
} from "../lib/discoveryEngineMode.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ADMIN_SRC = readFileSync(join(__dir, "..", "routes", "admin.ts"), "utf8");

describe("01 §8 — every engine state is reachable from the admin surface", () => {
  test("every accepted spelling parses to a state, and every state has a spelling", () => {
    const reached = new Set<string>();
    for (const spelling of ACCEPTED_ENGINE_MODE_SPELLINGS) {
      const state = parseEngineState(spelling);
      assert.notEqual(state, null, `admin would accept "${spelling}" but the resolver rejects it`);
      reached.add(state as string);
    }
    // The direction that actually caught the defect: a state the engine knows
    // and the operator cannot select.
    for (const state of DISCOVERY_ENGINE_STATES) {
      assert.ok(
        reached.has(state),
        `state "${state}" is resolvable but NO admin-accepted spelling selects it — ` +
          `it is unreachable from the shipping product`,
      );
    }
    assert.equal(DISCOVERY_ENGINE_STATES.length, 5, "01 §8 names five states");
  });

  test("routes/admin.ts derives the list rather than re-typing it", () => {
    assert.match(
      ADMIN_SRC,
      /DISCOVERY_ENGINE_MODE:\s*\{\s*key:\s*"mode",\s*allowed:\s*ACCEPTED_ENGINE_MODE_SPELLINGS\s*\}/,
      "the admin allowed-list is a literal again — derive it from the resolver, " +
        "or compare and partial silently stop being selectable",
    );
    assert.ok(
      ACCEPTED_ENGINE_MODE_SPELLINGS.includes("compare") &&
        ACCEPTED_ENGINE_MODE_SPELLINGS.includes("partial"),
      "the two states the hand-maintained list omitted must be admin-selectable",
    );
  });

  test("an unknown spelling is still refused — the constraint is not merely widened", () => {
    for (const bad of ["", "pdee", "LEGACY ", "constructor", "__proto__", "toString"]) {
      assert.equal(parseEngineState(bad), null, `"${bad}" must not resolve to a state`);
      assert.ok(!ACCEPTED_ENGINE_MODE_SPELLINGS.includes(bad), `"${bad}" must not be admin-accepted`);
    }
  });
});
