/**
 * census-discovery DV-44 (`04` §10.2): "audit every allowed `surface`; prove at
 * least one intentional writer OR RETIRE IT" — as an executable proof over the
 * tree, not a paragraph.
 *
 * READ census-discovery §41.1 FIRST. DV-44's own evidence cell names NINE
 * writerless surfaces, including `living_page` and `watch_feed`. Both have live
 * writers; narrowing the CHECK to the census's nine would make every
 * `watch_feed` impression a silent 23514. This file is the guard against that
 * mistake as much as it is the proof of the row:
 *
 *   P1  The vocabulary production admits today is 2298's fifteen labels (2893
 *       is NOT applied there — owner-deferred). Exactly 2893's eight KEPT
 *       labels have an intentional writer in the tree, each located by file
 *       and call-site text below, and exactly 2893's seven RETIRED labels have
 *       none. The partition is total and the census's nine is wrong twice.
 *   P2  The code's own write vocabulary (PERSISTED_RANK_SURFACES) is the eight,
 *       so no ranker path can reach a retired label even while the database
 *       still admits it — the retirement is in force in CODE today.
 *   P3  No non-test source file names a retired label as a rank_events surface.
 *   P4  2893 cannot retire a surface production uses: its precondition counts
 *       rows per retired label and refuses to run over any, and its postcondition
 *       re-asserts `watch_feed` and `living_page`.
 *
 * WHAT THIS DOES NOT PROVE: that 2893 is APPLIED. It is not, on production, by
 * the owner's deferral recorded in production-deployment-2026-09-14.md. The
 * database-level retirement is therefore a deployment step, not code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PERSISTED_RANK_SURFACES } from "../services/ranking/DiscoveryRankingService.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");
const MIG = resolve(SRC, "migrations");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

/** The labels inside the LAST `ADD CONSTRAINT rank_events_surface_check … ARRAY[ … ]` of a file. */
function surfaceVocabulary(file: string): string[] {
  const sql = readFileSync(join(MIG, file), "utf8").replace(/--[^\n]*/g, "");
  const blocks = [...sql.matchAll(/ADD CONSTRAINT rank_events_surface_check\s+CHECK \(surface = ANY \(ARRAY\[([\s\S]*?)\]/g)];
  assert.ok(blocks.length > 0, `${file} declares no surface CHECK`);
  return [...blocks.at(-1)![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

/** One intentional writer per kept surface: the file, and text that exists only at the write. */
const WRITERS: Record<string, { file: string; needle: string | RegExp }> = {
  pulse:       { file: "routes/pulse.ts",       needle: /void logImpression\([^;]{0,200}?"pulse",/ },
  discovery:   { file: "lib/discoveryServeLog.ts", needle: `surface:    "discovery",` },
  events:      { file: "routes/events.ts",      needle: `logImpression(rankedScored.slice(offset, offset + limit), user.id, "events"` },
  compass:     { file: "lib/rankLog.ts",        needle: `surface:    "compass",` },
  live_pulse:  { file: "lib/rankLog.ts",        needle: `surface:      "live_pulse" as const,` },
  living_page: { file: "routes/rankEvents.ts",  needle: `surface: "living_page"` },
  watch_feed:  { file: "routes/mediaFeed.ts",   needle: `surface:    "watch_feed",` },
  wall:        { file: "routes/wall.ts",        needle: `surface: "wall",` },
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["test", "__tests__", "migrations", "generated"].includes(name)) continue;
      sourceFiles(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("DV-44 — every allowed surface has an intentional writer, or is retired", () => {
  const admitted = surfaceVocabulary("2298_dead_check_vocabularies.sql");
  const kept     = surfaceVocabulary("2893_rank_events_retire_writerless_surfaces.sql");
  const retired  = admitted.filter((s) => !kept.includes(s));

  it("P1. production admits 15; the 8 kept each have a located writer; the 7 retired are exactly the rest", () => {
    assert.equal(admitted.length, 15, `2298's vocabulary — production's, since 2893 is unapplied there: ${admitted}`);
    assert.deepEqual(kept, Object.keys(WRITERS).sort(), "the kept set is exactly the writer-backed set");
    for (const [surface, w] of Object.entries(WRITERS)) {
      const text = read(w.file);
      const found = typeof w.needle === "string" ? text.includes(w.needle) : w.needle.test(text);
      assert.ok(found, `${surface}: no write found at ${w.file} (${w.needle}) — the writer moved or died`);
    }
    assert.deepEqual(retired, ["event", "explore", "nearby", "profile", "search", "story", "trip"]);
    for (const s of ["living_page", "watch_feed"]) {
      assert.ok(kept.includes(s), `§41.1: ${s} HAS a writer; the census's nine is wrong about it`);
    }
  });

  it("P2. the code's own write vocabulary is the eight — no ranker path can reach a retired label", () => {
    assert.deepEqual([...PERSISTED_RANK_SURFACES].sort(), kept);
  });

  it("P3. no non-test source names a retired label as a rank_events surface", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
      for (const s of retired) {
        if (new RegExp(`surface\\s*:\\s*["']${s}["']`).test(text) || new RegExp(`\\.eq\\(\\s*["']surface["']\\s*,\\s*["']${s}["']`).test(text)) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${s}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "a retired label with a writer is a surface 2893 would silently black out");
  });

  it("P4. 2893 refuses to retire a label production holds rows for, and re-asserts the two §41.1 surfaces", () => {
    const sql = readFileSync(join(MIG, "2893_rank_events_retire_writerless_surfaces.sql"), "utf8");
    assert.match(sql, /FOREACH label IN ARRAY ARRAY\['search','nearby','story','event','trip','profile','explore'\] LOOP\s+EXECUTE 'SELECT count\(\*\) FROM public\.rank_events WHERE surface = \$1'/,
      "the precondition counts rows per retired label");
    assert.match(sql, /PRECONDITION FAILED \(2893\): % row\(s\) carry a surface this file retires/);
    for (const s of ["watch_feed", "living_page"]) assert.ok(kept.includes(s));
  });
});
