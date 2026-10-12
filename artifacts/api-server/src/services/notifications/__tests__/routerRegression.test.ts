/**
 * OD-1012-LAY-4a (owner, 2026-10-12): "Review unrelated notification types for
 * regressions because #701 changes their shared router."
 *
 * Every notification type the router can see — each NotificationTemplateService
 * TEMPLATE (default priority and urgent) and synthetic rows for every category
 * x every branch of the router's type map x every priority — is routed under
 * four traveller settings (defaults, quiet hours with and without the safety
 * override, push off) with the time-sensitive rollout switch OFF and ON
 * (routerDecisionMatrix.ts). Each observable decision (every Expo message
 * field, every delivery-attempt row) is digested per category|eventType.
 *
 *   1. The golden digests were produced by the SAME matrix against origin/main
 *      77aac9e50's router (routerDecisionGolden.main.json). Every non-layover
 *      type must reproduce main's digest exactly.
 *   2. Only `layover.return.start_heading_back / leave_now / get_help` may
 *      differ — the change re-routes exactly those (and `explore`, which asks
 *      nothing of the traveller, routes exactly as on main).
 *   3. The rollout switch changes nothing for any non-layover type, whatever
 *      the device rows say about capability.
 *
 * Regenerating the golden (only ever from main's sources): check out main's
 * NotificationRouter.ts, lib/push.ts and LayoverReturnEscalation.ts over this
 * tree, run runRouterMatrix + digestByType, restore.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/notifications/__tests__/routerRegression.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NotificationRouter } from "../NotificationRouter.js";
import { TEMPLATES } from "../NotificationTemplateService.js";
import { _setTestFetch } from "../../../lib/push.js";
import { runRouterMatrix, digestByType, typeOf, type Decision } from "./routerDecisionMatrix.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "routerDecisionGolden.main.json"), "utf8")) as { digests: Record<string, string> };

const INTENDED = new Set(["airport|layover.return.start_heading_back", "airport|layover.return.leave_now", "airport|layover.return.get_help"]);

let decisions: Decision[] = [];
before(async () => { decisions = await runRouterMatrix(NotificationRouter as any, _setTestFetch, TEMPLATES); });

describe("LAY-4a regression review: the shared router routes every unrelated type exactly as on main", () => {
  it("the matrix covers every template and every category the router maps", () => {
    const types = new Set(decisions.map((d) => typeOf(d.key)));
    for (const t of TEMPLATES) assert.ok(types.has(`${t.category}|${t.eventType}`), `${t.category}|${t.eventType} not exercised`);
    for (const c of ["safety", "moderation", "trip", "booking", "message", "social", "compass", "discovery", "airport", "admin"]) {
      assert.ok([...types].some((t) => t.startsWith(`${c}|`)), `category ${c} not exercised`);
    }
    assert.equal(Object.keys(golden.digests).length, types.size, "the golden and the branch matrix cover the same types");
  });

  it("every non-layover category|eventType reproduces main's decisions (golden digest)", () => {
    const now = digestByType(decisions);
    const changed = Object.keys(golden.digests).filter((t) => golden.digests[t] !== now[t]);
    const unintended = changed.filter((t) => !INTENDED.has(t));
    assert.deepEqual(unintended, [], `routing changed for unrelated types: ${unintended.join(", ")}`);
    assert.ok(Object.keys(golden.digests).length > 300);
  });

  it("…and the three actionable layover return warnings are the ONLY types that changed", () => {
    const now = digestByType(decisions);
    const changed = Object.keys(golden.digests).filter((t) => golden.digests[t] !== now[t]).sort();
    assert.deepEqual(changed, [...INTENDED].sort());
  });

  it("the rollout switch changes nothing for any non-layover type, even with a capable device registered", () => {
    const by = new Map(decisions.map((d) => [d.key, d]));
    let compared = 0;
    for (const d of decisions) {
      if (!d.key.startsWith("off|") || d.key.includes("|layover.return.")) continue;
      const on = by.get(`on|${d.key.slice(4)}`)!;
      assert.deepEqual(on.sent, d.sent, d.key);
      assert.deepEqual(on.attempts, d.attempts, d.key);
      compared++;
    }
    assert.ok(compared > 4000, `compared ${compared}`);
  });

  it("no message for any type ever asks for an interruption level other than time-sensitive (never critical)", () => {
    for (const d of decisions) for (const m of d.sent as Array<Record<string, unknown>>) {
      if ("interruptionLevel" in m) {
        assert.equal(m.interruptionLevel, "time-sensitive", d.key);
        assert.ok(d.key.startsWith("on|") && d.key.includes("|layover.return."), `level on ${d.key}`);
        assert.equal(m.to, "ExponentPushToken[ios_capable]", "only the device that reported the capability");
      }
    }
  });
});
