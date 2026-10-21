/**
 * LAYOVER 165, lane B2-CURATE — the launch-city curation packets
 * (docs/ops/airport-curation/<IATA>.json) are PROPOSALS from official sources,
 * in the shape the curation workflow ingests, and nothing in them claims to be
 * validated. A human curator validates them; this suite only proves they are
 * honest inputs to that step.
 *
 *   K1  every packet is version 1, names its airport, and says it is proposed and unvalidated
 *   K2  every fact names a curated kind, an OFFICIAL source with its https URL and when it was read
 *   K3  no packet proposes timing_assumptions (Portava's own buffers are a curator's judgment)
 *   K4  every packet is accepted by the workflow's packet check, and each fact's quality preview is computed (not asserted to pass)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultExpiryMs, isCuratedFactKind, terminalIdsOf, validateCuratedFact } from "../services/airport/airportCurationPolicy.js";
import { isCurationPacket } from "../services/airport/airportCuration.js";

const DIR = join(import.meta.dirname, "../../../../docs/ops/airport-curation");
const LAUNCH = ["BKK", "DAD", "FLL", "HND", "MIA", "MNL", "NRT"];
const packets = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f, p: JSON.parse(readFileSync(join(DIR, f), "utf8")) }));

describe("launch-city curation packets", () => {
  it("K1 one packet per launch airport, each proposed and unvalidated", () => {
    assert.deepEqual(packets.map((x) => x.p.iata), LAUNCH);
    for (const { file, p } of packets) {
      assert.equal(p.packetVersion, 1, file);
      assert.equal(p.state, "proposed_unvalidated", file);
      assert.match(p.preparedBy, /NOT validated/, file);
      assert.ok(Array.isArray(p.unreachable) && Array.isArray(p.gaps), file);
      assert.ok(p.facts.length > 0 || p.unreachable.length > 0, `${file}: an empty packet must say which sources could not be reached`);
    }
  });

  it("K2 every fact is a curated kind from an official https source with its retrieval time", () => {
    for (const { file, p } of packets) {
      for (const f of p.facts) {
        assert.ok(isCuratedFactKind(f.kind), `${file}: ${f.kind}`);
        assert.ok(["official_airport", "official_operator", "official_government"].includes(f.source.kind), `${file} ${f.kind}: ${f.source.kind}`);
        assert.match(f.source.url, /^https:\/\//, `${file} ${f.kind}`);
        assert.ok(Number.isFinite(Date.parse(f.source.retrievedAt)), `${file} ${f.kind}: retrievedAt`);
        assert.ok(!("state" in f) && !("validatedBy" in f) && !("publishedAt" in f), `${file} ${f.kind}: a packet never carries a validation`);
      }
    }
  });

  it("K3 no packet proposes Portava's own buffers", () => {
    for (const { file, p } of packets) assert.ok(!p.facts.some((f: any) => f.kind === "timing_assumptions"), file);
  });

  it("K4 the workflow accepts each packet; each fact's quality preview is computed and reported", () => {
    const report: string[] = [];
    for (const { file, p } of packets) {
      assert.ok(isCurationPacket(p), file);
      const topo = p.facts.find((f) => f.kind === "terminal_topology");
      for (const f of p.facts) {
        assert.ok(isCuratedFactKind(f.kind), `${file}: ${String(f.kind)}`);
        assert.equal(typeof f.source.retrievedAt, "string", `${file}: source retrieval time`);
        assert.ok(typeof f.source.retrievedAt === "string");
        assert.ok(f.source.kind === "official_airport" || f.source.kind === "official_operator" || f.source.kind === "official_government");
        assert.ok(typeof f.source.url === "string");
        assert.ok(f.source.title === undefined || typeof f.source.title === "string");
        const at = Date.parse(f.source.retrievedAt);
        const r = validateCuratedFact(f.kind, f.value, { kind: f.source.kind, url: f.source.url, title: f.source.title ?? null, note: null, retrievedAt: f.source.retrievedAt },
          defaultExpiryMs(f.kind, at), at + 60_000, { publishedTerminals: topo ? terminalIdsOf(topo.value) : null });
        assert.ok(r.checks.length > 0, `${file} ${f.kind}`);
        report.push(`${p.iata} ${f.kind}: ${r.ok ? "preview passes" : `curator must complete (${r.issues.length} issue(s))`}`);
      }
    }
    assert.ok(report.length > 0);
  });
});
