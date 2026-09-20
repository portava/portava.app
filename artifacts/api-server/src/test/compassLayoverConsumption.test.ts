/**
 * census-compass CL-03 and CL-04 — Compass consumes the layover domain's ONE
 * certified door, and the layover replanner's OpportunityEvents reach Compass.
 *
 * CL-03: `services/airport/LayoverSnapshot.certifiedLayoverSnapshot` had zero
 * non-test callers; Compass had no layover code and no time-budget logic of
 * its own. Now `/compass/ask` pushes a certified snapshot line when the user
 * is in a live layover (proactive — the deadline must not depend on the model
 * electing to call a tool), and `get_layover_snapshot` is a tool for the
 * follow-up questions. Both refuse honestly: an UNREADABLE session store is
 * said so, never read as "no layover".
 *
 * CL-04: `opportunityEventFor` / `shouldNotify` produced OpportunityEvents on
 * every material change and nothing consumed them. Now the replan route hands
 * a notify-worthy one to `LayoverOpportunityNotifier`, which makes it a
 * `compass` notification (a WORLD CHANGE to the Attention Engine, Sensing §15)
 * declaring what it knows: the traveller's own layover (`trip_stop`) at the
 * replanner's urgency.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 an unreadable session store reported as noLayover            → red
 *   M2 the tool leaks the certified record                          → red
 *   M3 the notifier emits for a change shouldNotify declined        → red
 *   M4 the notifier declares no relevance (the change may interrupt nobody) → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassLayoverConsumption.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toolGetLayoverSnapshot, COMPASS_TOOL_DEFINITIONS, COMPASS_TOOL_NAMES } from "../compass/CompassTools.js";
import { layoverOpportunityPayload, URGENCY_OF_PRIORITY, LAYOVER_OPPORTUNITY_EVENT_TYPE } from "../services/airport/LayoverOpportunityNotifier.js";
import { ATTENTION_BY_EVENT_TYPE, worldChangeFactors } from "../compass/CompassNotificationEngine.js";
import { ATTENTION_RELEVANCE, NOTIFY_URGENCY_FLOOR } from "../lib/attentionEngine.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const USER = "aa000000-0000-4000-8000-000000000001";

/** A client whose layover_sessions read answers as told. */
function sessionsDb(mode: "unreadable" | "none") {
  const b: any = {
    select() { return b; }, eq() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle() { return Promise.resolve(mode === "unreadable" ? { data: null, error: { message: "connection reset", code: "08006" } } : { data: null, error: null }); },
    then(res: any) { res(mode === "unreadable" ? { data: null, error: { message: "connection reset", code: "08006" } } : { data: [], error: null }); },
  };
  return { from: () => b } as any;
}

describe("CL-03 — one certified door, consumed", () => {
  it("get_layover_snapshot is declared and dispatchable", () => {
    assert.ok(COMPASS_TOOL_NAMES.has("get_layover_snapshot"));
    const def = COMPASS_TOOL_DEFINITIONS.find((t) => t.function.name === "get_layover_snapshot");
    assert.match(def!.function.description, /never compute a time budget yourself/);
  });

  it("an UNREADABLE session store is `unavailable`, never `noLayover`", async () => {
    const r: any = await toolGetLayoverSnapshot(sessionsDb("unreadable"), USER);
    assert.equal(r.unavailable, true, JSON.stringify(r));
    assert.equal(r.noLayover, undefined);
    assert.match(String(r.reason), /unreadable/);
  });

  it("no live session is `noLayover`, an answer not a refusal", async () => {
    const r: any = await toolGetLayoverSnapshot(sessionsDb("none"), USER);
    assert.equal(r.noLayover, true, JSON.stringify(r));
    assert.equal(r.unavailable, undefined);
  });

  it("the tool and the ask context both consume certifiedLayoverSnapshot, and the tool drops the certified record", () => {
    const tools = strip(readFileSync(join(SRC, "compass", "CompassTools.ts"), "utf8"));
    assert.match(tools, /import \{ certifiedLayoverSnapshot, isDegradedRefusal \} from "\.\.\/services\/airport\/LayoverSnapshot\.js"/);
    assert.match(tools, /const \{ certifiedRecord: _record, \.\.\.snapshot \} = r\.snapshot;/);
    const route = strip(readFileSync(join(SRC, "routes", "compass.ts"), "utf8"));
    assert.match(route, /const snap = await certifiedLayoverSnapshot\(sc, user\.id\);/);
    assert.match(route, /Could not be read \(\$\{snap\.reason\}\); do not assume the traveller is not in a layover\./);
    // No time budget of Compass's own: nothing under compass/ subtracts a deadline from now.
    assert.doesNotMatch(tools, /hardReturn\w*\s*-\s*(?:Date\.now\(\)|nowMs)/);
  });
});

describe("CL-04 — OpportunityEvents reach Compass as world changes", () => {
  const publication = (over: Record<string, unknown> = {}) => ({
    wiringVersion: "w", replannerVersion: "r",
    event: { eventId: "e1", eventType: "flight.departure_delayed", occurredAt: "t", receivedAt: "t", source: "portava.layover.session_edit", dedupKey: "dk", confidence: "stated" },
    diff: {}, invalidation: {},
    opportunity: { why: ["usable time moved by 45 min", "2 new option(s) fit"], reasonCodes: ["FLIGHT_DELAY_CREATED_OPPORTUNITY"] },
    notify: { notify: true, priority: "normal", reason: "a delay opened a materially larger window" },
    disruptionState: null, certification: {}, reasonCodes: [], snapshotPersisted: false, snapshotUnavailableReason: "no_snapshot_storage",
    counts: { impacted: 1, replanned: 1, skipped: 0, notifications: 0 },
    ...over,
  }) as any;

  it("a notify-worthy opportunity becomes a compass notification payload declaring trip_stop relevance at the replanner's urgency", () => {
    const p = layoverOpportunityPayload("sess-1", publication());
    assert.ok(p);
    assert.equal(p.priority, "normal");
    assert.equal(p.attention.relevance, "trip_stop");
    assert.ok((ATTENTION_RELEVANCE as readonly string[]).includes(String(p.attention.relevance)));
    assert.equal(p.attention.urgency, URGENCY_OF_PRIORITY.normal);
    assert.equal(p.attention.subjectId, "layover:sess-1");
    assert.match(p.body, /usable time moved by 45 min/);
  });

  it("a high-priority change (an option no longer fits) reaches the NOTIFY floor; a normal one does not interrupt on its own", () => {
    const high = layoverOpportunityPayload("s", publication({ notify: { notify: true, priority: "high", reason: "a planned option no longer fits the window" } }))!;
    assert.equal(high.priority, "important");
    assert.ok(Number(high.attention.urgency) >= NOTIFY_URGENCY_FLOOR);
    const normal = layoverOpportunityPayload("s", publication())!;
    assert.ok(Number(normal.attention.urgency) < NOTIFY_URGENCY_FLOOR);
  });

  it("no opportunity, or an opportunity shouldNotify declined, emits nothing", () => {
    assert.equal(layoverOpportunityPayload("s", publication({ opportunity: null })), null);
    assert.equal(layoverOpportunityPayload("s", publication({ notify: { notify: false, reason: "options moved, but nothing the traveller should do differently" } })), null);
  });

  it("the notification engine reads the declaration (declaration beats the event table) and the route emits after recording the decision", () => {
    const p = layoverOpportunityPayload("s", publication())!;
    const factors = worldChangeFactors({ type: "recommendation", title: p.title, body: p.body, data: { eventType: LAYOVER_OPPORTUNITY_EVENT_TYPE, attention: p.attention } });
    assert.deepEqual(factors, { relevance: "trip_stop", urgency: URGENCY_OF_PRIORITY.normal });
    assert.equal(ATTENTION_BY_EVENT_TYPE[LAYOVER_OPPORTUNITY_EVENT_TYPE], undefined, "the producer declares; no table entry is needed");
    const airport = strip(readFileSync(join(SRC, "routes", "airport.ts"), "utf8"));
    const record = airport.indexOf("await recordReplanDecision(args.sc, args.userId, result.publication, result.decision);");
    const notify = airport.indexOf("await notifyLayoverOpportunity(args.sc, args.userId, args.after.id, result.publication);");
    assert.ok(record > 0 && notify > record, "the opportunity is emitted after the DecisionRecord is written");
  });
});
