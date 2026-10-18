/**
 * census-layover L180 — `AirportTruthService.getTruth(subject, factType, atTime)`
 * READING THE STORE (layover lane 5, 2026-10-18).
 *
 * `getTruth` took its corpus as an argument because "there is no store";
 * `airport_fact_observations` (2860) is applied now. `getTruthFromStore` reads
 * it as of `atTime` and reconciles with the unchanged §10.1 policy. Pinned:
 *   - parity: the stored truth IS the pure reconciler's answer over the same
 *     rows — no second policy;
 *   - `atTime` is honoured at both ends (nothing observed after it, nothing
 *     expired at it), so a historical question is not answered from the future;
 *   - absent storage and failed reads are named refusals, never an empty truth;
 *   - it writes nothing, and it is NOT wired into the safety path (the owner's
 *     L81 decision): no service or route file names it.
 *
 * Run: node --import tsx/esm --test src/test/layoverStoredTruth.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  getTruth,
  getTruthFromStore,
  type AirportObservation,
} from "../services/airport/LayoverAirportTruth.js";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

/** One 2860 row, as PostgREST returns it: NUMERIC as a string. */
function row(id: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    id, airport_ref: "TPE", fact_type: "security_wait_minutes", fact_class: "FAST_LIVE",
    value: "30", observer_kind: "official", observer_id: "feed:tpe-ops", observer_trust: null,
    source_ref: `feed:tpe-ops/${id}`, observed_at: iso(-5), expires_at: iso(15), created_at: iso(-5),
    ...over,
  };
}

function asObservation(r: Record<string, any>): AirportObservation {
  return {
    observationId: r.id, airportRef: r.airport_ref, factType: r.fact_type, value: Number(r.value),
    observerKind: r.observer_kind, observerId: r.observer_id,
    ...(r.observer_trust === null ? {} : { observerTrust: Number(r.observer_trust) }),
    observedAt: r.observed_at, sourceRef: r.source_ref,
  };
}

describe("L180 — getTruthFromStore reads 2860 and reconciles with the SAME policy", () => {
  it("parity: the stored truth is exactly getTruth over the same rows", async () => {
    const rows = [
      row("o1", { value: "30" }),
      row("o2", { value: "55", observer_kind: "operator_feed", observer_id: "feed:airline", observed_at: iso(-2) }),
      row("o3", { airport_ref: "NRT", value: "90" }),
      row("o4", { fact_type: "taxi_queue_minutes", value: "40" }),
    ];
    const t: Record<string, any[]> = { airport_fact_observations: rows.map((r) => ({ ...r })) };
    const before = JSON.stringify(t);
    const out = await getTruthFromStore(makeLayoverDb(t) as any, "TPE", "security_wait_minutes", NOW);
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    // The store answers newest first (2860's lookup index); the pure call is given the rows in that order.
    const newestFirst = [...rows].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    const pure = getTruth("TPE", "security_wait_minutes", NOW, newestFirst.map(asObservation));
    assert.deepEqual(out.truth, pure);
    assert.equal(out.truth?.value, 55, "the conservative reading, as §10.1 rule 3 requires");
    assert.equal(out.truth?.conflict, true);
    assert.deepEqual([...out.truth!.sourceRefs].sort(), ["feed:tpe-ops/o1", "feed:tpe-ops/o2"]);
    assert.equal(JSON.stringify(t), before, "a read writes nothing");
  });

  it("nothing credible stored is truth: null — an absence, never a zero", async () => {
    const t: Record<string, any[]> = { airport_fact_observations: [] };
    const out = await getTruthFromStore(makeLayoverDb(t) as any, "TPE", "security_wait_minutes", NOW);
    assert.deepEqual(out.ok && out.truth, null);
  });

  it("community-only readings below the corroboration floor stay absent, read from the store as from a corpus", async () => {
    const t: Record<string, any[]> = {
      airport_fact_observations: [row("c1", { observer_kind: "community", observer_id: "tv1-abc", value: "80" })],
    };
    const out = await getTruthFromStore(makeLayoverDb(t) as any, "TPE", "security_wait_minutes", NOW);
    assert.ok(out.ok);
    assert.equal(out.ok && out.truth, null);
    assert.equal(out.ok && out.outcome.corroboration.community, 1);
  });
});

describe("L180 — atTime is honoured at both ends", () => {
  it("a reading observed AFTER atTime is not read at all — the past is not answered from the future", async () => {
    const t: Record<string, any[]> = {
      airport_fact_observations: [
        row("early", { value: "20", observed_at: iso(-30), expires_at: iso(-10) }),
        row("late", { value: "90", observed_at: iso(-5), expires_at: iso(15) }),
      ],
    };
    const atTime = NOW - 25 * 60_000;
    const out = await getTruthFromStore(makeLayoverDb(t) as any, "TPE", "security_wait_minutes", atTime);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.truth?.value, 20);
    assert.ok(out.outcome.screened.every((s) => s.observation.observationId !== "late"), "the later row never entered the corpus");
  });

  it("a reading whose stored expiry has passed at atTime is not read", async () => {
    const t: Record<string, any[]> = {
      airport_fact_observations: [row("stale", { value: "70", observed_at: iso(-40), expires_at: iso(-20) })],
    };
    const out = await getTruthFromStore(makeLayoverDb(t) as any, "TPE", "security_wait_minutes", NOW);
    assert.ok(out.ok);
    assert.equal(out.ok && out.outcome.screened.length, 0);
    assert.equal(out.ok && out.truth, null);
  });
});

describe("L180 — refusals are named, never an empty truth", () => {
  it("the table is not in this database: storage_unavailable", async () => {
    const db = makeLayoverDb({}, { failures: { "airport_fact_observations:select": { code: "42P01", message: 'relation "airport_fact_observations" does not exist' } } }) as any;
    assert.deepEqual(await getTruthFromStore(db, "TPE", "security_wait_minutes", NOW), { ok: false, reason: "storage_unavailable" });
  });

  it("any other read failure: read_failed", async () => {
    const db = makeLayoverDb({}, { failures: { "airport_fact_observations:select": { message: "timeout" } } }) as any;
    assert.deepEqual(await getTruthFromStore(db, "TPE", "security_wait_minutes", NOW), { ok: false, reason: "read_failed" });
  });
});

describe("L180 — available, and NOT wired into the safety path (owner decision L81)", () => {
  it("no service or route file calls getTruthFromStore — it decides nothing about using observations", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { if (!["test", "__tests__", "node_modules"].includes(e)) walk(p); }
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
      }
    };
    for (const d of ["services", "routes", "lib", "domain", "server"]) {
      try { walk(join(src, d)); } catch { /* a directory this tree does not have */ }
    }
    const callers = files.filter((f) => !f.endsWith("LayoverAirportTruth.ts") && readFileSync(f, "utf8").includes("getTruthFromStore"));
    assert.deepEqual(callers, []);
  });
});
