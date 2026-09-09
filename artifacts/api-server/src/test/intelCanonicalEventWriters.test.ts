/**
 * Which canonical verbs anything in this repository can actually WRITE.
 *
 * lib/canonicalEvents is the declared write side of the 2100 ingestion spine and
 * documents nine interaction verbs plus three intel domain verbs. Its two
 * writers, recordEvent/recordEvents, have NO caller outside
 * test/canonicalEvents.test.ts. The only two production modules that insert into
 * canonical_events are lib/intelOutcomes and lib/intelDomainEvents, and both
 * bypass recordEvents — they call projectEvent and insert the row themselves
 * (deliberately: one needs the inserted id, the other needs per-row 23505
 * tolerance).
 *
 * The consequence is measured below at RUNTIME, by counting the verbs those two
 * modules put on the wire against a fake that records every insert:
 *
 *   WRITTEN   arrival, completion, rejection            (family 'outcome')
 *             intel.observation.recorded,
 *             intel.claim.promoted, intel.state.changed (family 'domain')
 *
 *   STARVED   impression                                (family 'exposure')
 *             open, save, join, direction               (family 'action')
 *             satisfaction                              (family 'satisfaction')
 *
 * So `canonical_event_families WHERE family IN ('exposure','action','satisfaction')`
 * can only ever return zero rows. That is an INSTRUMENTATION GAP — three whole
 * funnel families with no producer — not a refactor of these two modules, and it
 * is deliberately NOT closed by inventing emissions here. lib/intelFunnelReport
 * and routes/intelObservability compute exposure/action ratios over those
 * families; every such ratio is structurally zero or undefined today.
 *
 * WHEN AN EMITTER IS ADDED. This file goes red on purpose. Move the verb from
 * STARVED_VERBS to WRITTEN_VERBS and add its writer to CANONICAL_EVENT_WRITERS —
 * that edit is the record that the gap closed.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/intelCanonicalEventWriters.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { CANONICAL_EVENT_VERBS } from "../lib/canonicalEvents.js";
import { VERB_FAMILY, type EventFamily } from "../lib/eventFamilies.js";
import { INTEL_OUTCOMES, OUTCOME_VERB, recordIntelOutcome } from "../lib/intelOutcomes.js";
import { emitPromotionDomainEvents, emitStateChangedEvents, type SnapshotRow } from "../lib/intelDomainEvents.js";

const SRC = dirname(dirname(fileURLToPath(import.meta.url))); // .../src

/** Every verb lib/intelOutcomes can BUILD, read off its own outcome->verb map. */
const INTEL_OUTCOME_VERBS_FOR_TEST: string[] = [...new Set(Object.values(OUTCOME_VERB))];

/** Every non-test .ts file under src/ (the whole tree, not just intel). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test" || e.name === "__tests__" || e.name === "node_modules" || e.name === "migrations") continue;
      sourceFiles(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** The modules permitted to insert into canonical_events. */
const CANONICAL_EVENT_WRITERS = [
  "lib/canonicalEvents.ts",   // recordEvents — the declared writer, with no caller
  "lib/intelOutcomes.ts",     // I4a outcome events
  "lib/intelDomainEvents.ts", // §21 domain transitions
];

const WRITTEN_VERBS = [
  "arrival", "completion", "rejection",
  "intel.observation.recorded", "intel.claim.promoted", "intel.state.changed",
];

const STARVED_VERBS = ["impression", "open", "save", "join", "direction", "satisfaction"];
const STARVED_FAMILIES: EventFamily[] = ["exposure", "action", "satisfaction"];

describe("the corpus: who may insert into canonical_events at all", () => {
  const files = sourceFiles(SRC);

  it("the scan found source files (vacuity guard)", () => {
    assert.ok(files.length > 200, `only ${files.length} source files scanned`);
  });

  it("exactly three modules insert into canonical_events", () => {
    const writers: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // `.from("canonical_events")` followed by `.insert(` within the statement.
      if (/\.from\(\s*["']canonical_events["']\s*\)[\s\S]{0,400}?\.insert\(/.test(src)) {
        writers.push(relative(SRC, f).replace(/\\/g, "/"));
      }
    }
    assert.deepEqual(writers.sort(), [...CANONICAL_EVENT_WRITERS].sort());
  });

  it("recordEvent / recordEvents have NO production caller — the declared writer is dead", () => {
    const callers: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f).replace(/\\/g, "/");
      if (rel === "lib/canonicalEvents.ts") continue; // its own definitions
      if (/\brecordEvents?\s*\(/.test(readFileSync(f, "utf8"))) callers.push(rel);
    }
    assert.deepEqual(callers, [],
      "recordEvent/recordEvents gained a production caller — update this file and the header's account of the gap");
  });
});

// ── The runtime half: count what the two live writers actually put on the wire ──

/** Records every canonical_events row inserted, and answers the reads each emitter makes. */
function spy(cfg: { snapshots?: any[]; claims?: any[]; observations?: any[]; events?: any[] } = {}) {
  const inserted: any[] = [];
  const existing: any[] = [...(cfg.events ?? [])];
  const resolve = (row: any, col: string): any => {
    const m = /^payload->intel->>(.+)$/.exec(col);
    return m ? row?.payload?.intel?.[m[1]] : row?.[col];
  };
  function from(table: string) {
    let op: "select" | "insert" = "select";
    let payload: any = null;
    const eqs: [string, any][] = [];
    const ins: [string, any[]][] = [];
    const src = (): any[] => (({
      intel_state_snapshots: cfg.snapshots ?? [],
      intel_claims: cfg.claims ?? [],
      intel_observations: cfg.observations ?? [],
      canonical_events: existing,
    } as any)[table] ?? []);
    const match = (r: any) => eqs.every(([c, v]) => resolve(r, c) === v) && ins.every(([c, vs]) => vs.includes(resolve(r, c)));
    const run = () => {
      if (op === "insert") {
        if (table === "canonical_events") { inserted.push(payload); existing.push(payload); }
        return { data: { id: `ev-${inserted.length}` }, error: null };
      }
      return { data: src().filter(match), error: null };
    };
    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      not() { return b; }, order() { return b; }, gte() { return b; },
      limit() { return Promise.resolve(run()); },
      single() { return Promise.resolve({ data: { id: `ev-${inserted.length + 1}` }, error: null, ...(run(), {}) }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from, _verbs: () => inserted.map((r) => r.verb), _inserted: inserted };
}

const NOW = new Date("2026-09-08T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 30 * 60_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 30 * 60_000).toISOString();

describe("the two live writers, counted at runtime", () => {
  it("lib/intelOutcomes writes ONLY outcome-family verbs — one per Appendix-A outcome", async () => {
    const seen = new Set<string>();
    for (const outcome of INTEL_OUTCOMES) {
      const snapshot = {
        id: `s-${outcome}`, subject_id: "p1", zone_id: null, claim_type: "crowd.level",
        confidence: 0.7, source_count: 20, privacy_eligible: true, observed_at: PAST, expires_at: FUTURE,
      };
      const db = spy({ snapshots: [snapshot], claims: [{ id: "c1", subject_id: "p1", zone_id: null, claim_type: "crowd.level" }] });
      const r = await recordIntelOutcome(db as any, "actor-1", {
        snapshotId: snapshot.id, claimId: "c1", outcome, servedAt: PAST, touch: "go_tap",
      } as any, NOW);
      assert.equal(r.ok, true, `${outcome}: ${JSON.stringify(r)}`);
      const verbs = db._verbs();
      assert.equal(verbs.length, 1, `${outcome} wrote ${verbs.length} events`);
      seen.add(verbs[0]);
    }
    assert.deepEqual([...seen].sort(), ["arrival", "completion", "rejection"]);
    for (const v of seen) assert.equal(VERB_FAMILY[v as keyof typeof VERB_FAMILY], "outcome");
  });

  it("lib/intelDomainEvents writes ONLY the three domain verbs", async () => {
    const promo = spy({
      claims: [{ id: "c1", subject_id: "p1", zone_id: null, claim_type: "crowd.level", confidence: 0.6, confidence_band: "live", observed_at: PAST, promotion_source: "system", status: "active", created_at: PAST }],
      observations: [{ id: "o1", subject_id: "p1", zone_id: null, claim_type: "crowd.level", observed_at: PAST, source_class: "firsthand_unverified", presence_level: "P0", actor_id: "a1" }],
    });
    const pr = await emitPromotionDomainEvents(promo as any, { now: NOW });
    assert.equal(pr.claimsPromoted, 1, "vacuity guard: the promotion emitter wrote nothing");
    assert.equal(pr.observationsRecorded, 1);

    const state = spy();
    const snap: SnapshotRow = {
      id: "s1", subject_id: "p1", zone_id: null, claim_type: "crowd.level",
      value: { level: "busy" }, confidence: 0.6, confidence_band: "live",
      privacy_eligible: true, observed_at: PAST, expires_at: FUTURE,
    };
    const sr = await emitStateChangedEvents(state as any, new Map(), new Map([["k", snap]]), [], { now: NOW });
    assert.equal(sr.stateChanged, 1, "vacuity guard: the state emitter wrote nothing");

    const verbs = [...new Set([...promo._verbs(), ...state._verbs()])].sort();
    assert.deepEqual(verbs, ["intel.claim.promoted", "intel.observation.recorded", "intel.state.changed"]);
    for (const v of verbs) assert.equal(VERB_FAMILY[v as keyof typeof VERB_FAMILY], "domain");
  });
});

describe("THE GAP: three whole families have no writer", () => {
  it("WRITTEN + STARVED partitions the canonical verb set exactly", () => {
    assert.deepEqual(
      [...WRITTEN_VERBS, ...STARVED_VERBS].sort(),
      [...CANONICAL_EVENT_VERBS].sort(),
      "a canonical verb is in neither list (or in both) — the partition below proves nothing",
    );
    assert.equal(new Set([...WRITTEN_VERBS, ...STARVED_VERBS]).size, CANONICAL_EVENT_VERBS.length);
  });

  it("every starved verb's family is exposure, action or satisfaction — and those families have NOTHING else in them", () => {
    for (const v of STARVED_VERBS) {
      const fam = VERB_FAMILY[v as keyof typeof VERB_FAMILY];
      assert.ok(STARVED_FAMILIES.includes(fam), `'${v}' is in family '${fam}', not a starved one`);
    }
    // The other half of the claim: no WRITTEN verb rescues those families, so
    // `WHERE family IN ('exposure','action','satisfaction')` is structurally empty.
    for (const v of WRITTEN_VERBS) {
      const fam = VERB_FAMILY[v as keyof typeof VERB_FAMILY];
      assert.equal(STARVED_FAMILIES.includes(fam), false, `'${v}' IS written and lands in starved family '${fam}'`);
    }
  });

  it("the two live writers' runtime verb set contains no starved verb", () => {
    // Belt and braces over the two runtime cases above: nothing either module can
    // BUILD carries a starved verb, so the runtime observation is not a fixture
    // artefact.
    for (const v of INTEL_OUTCOME_VERBS_FOR_TEST) {
      assert.equal(STARVED_VERBS.includes(v), false);
    }
    assert.ok(INTEL_OUTCOME_VERBS_FOR_TEST.length > 0, "inspected nothing");
  });
});
