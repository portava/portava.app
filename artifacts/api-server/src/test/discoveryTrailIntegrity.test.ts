/**
 * census-discovery §61 — the parts of DC-03, DC-20 and DV-72 that need no
 * database: the contracts between the new SQL and the TypeScript it mirrors,
 * the refusal mapping of the two new service seams, and the ranker hold on the
 * new projection. The database halves are src/test/db/trailsProposalRace,
 * trailsAttachIntegrity and trailRelationsRebuild (*.db.test.ts).
 *
 *   C1–C4  3415 carries the TypeScript's thresholds, pigeonhole, waiver set and
 *          rounding, read as TEXT (the drift hazard 3415's header names)
 *   C5     3416's relation kinds are 02 §6's six plus common_content
 *   C6     nothing outside migrations and tests reads trail_relations (the
 *          ROADMAP 2026-08-15 ranker hold)
 *   T1–T6  commitTrailProposal: every answer of trail_propose is mapped, a
 *          missing function is `unavailable`, an unknown shape is an error
 *   V1–V7  verifyAttachSources: the type gate, both place tables, fail-closed
 *          reads, the visibility helper's verdict, request order
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  DUPLICATE_TITLE_SIMILARITY, DESTINATION_OVERLAP_SIMILARITY, SEMANTIC_OVERLAP_SIMILARITY, TRAIL_EDGE_TYPES,
  canonicalTrailSlug, canonicaliseTrailProposal,
} from "../lib/discoveryTrailObject.js";
import { strokeFold } from "../lib/canonicalLocations.js";
import { TRAIL_LETTER_FOLD, trailLetterFold } from "../lib/discoveryTrailFold.js";
import { computeLocalMomentum, type MomentumRow } from "../lib/discoveryLocalMomentum.js";
import { trailMomentumFromRankEvents } from "../lib/discoveryTrailAffinity.js";
import { commitTrailProposal, isMissingProposalFunction } from "../services/trails/trailProposal.js";
import { verifyAttachSources, VERIFIABLE_TRAIL_SOURCE_TYPES } from "../services/trails/trailAttachIntegrity.js";
import { exposureCountsFrom, type MemberRow, type ServableMember } from "../services/trails/TrailService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const M3415 = read("migrations/3415_trail_proposal_serialised.sql");
const M3416 = read("migrations/3416_trail_relations_projection.sql");
const SERVICE = read("services/trails/TrailService.ts");

describe("C — 3415 and 3416 carry the TypeScript's rules", () => {
  it("C1. the three thresholds are DUPLICATE / DESTINATION_OVERLAP / SEMANTIC_OVERLAP_SIMILARITY", () => {
    const constant = (name: string) => Number(new RegExp(`${name}\\s+CONSTANT double precision := ([0-9.]+);`).exec(M3415)?.[1]);
    assert.equal(constant("c_duplicate"), DUPLICATE_TITLE_SIMILARITY);
    assert.equal(constant("c_destination"), DESTINATION_OVERLAP_SIMILARITY);
    assert.equal(constant("c_semantic"), SEMANTIC_OVERLAP_SIMILARITY);
  });

  it("C2. the peer read's pigeonhole bound uses the duplicate threshold, in doubles", () => {
    assert.match(M3415, new RegExp(`ceil\\(${DUPLICATE_TITLE_SIMILARITY}::double precision \\* cardinality\\(v_tokens\\)::double precision\\)`));
    assert.match(SERVICE, /const needed = tokens\.length - Math\.ceil\(DUPLICATE_TITLE_SIMILARITY \* tokens\.length\) \+ 1;/);
  });

  it("C3. the declared parent waives the same three checks in SQL as in proposeTrail", () => {
    const ts = /const WAIVED_BY_PARENT = new Set\(\[([^\]]*)\]\)/.exec(SERVICE)?.[1];
    const sqlSet = /x\.r ->> 'check' IN \(([^)]*)\)/.exec(M3415)?.[1];
    assert.ok(ts && sqlSet);
    const words = (s: string) => [...s.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]).sort();
    assert.deepEqual(words(sqlSet!), words(ts!));
  });

  it("C4. similarity rounds half UP (Math.round), never with round() on a double (half to even)", () => {
    const body = M3415.slice(M3415.indexOf("FUNCTION public.trail_token_similarity"), M3415.indexOf("FUNCTION public.trail_canonicalisation_verdict"));
    assert.match(body, /IF x - r >= 0\.5::double precision THEN/);
    assert.doesNotMatch(body, /\bround\(/);
  });

  it("C5. 3416's relation kinds are 02 §6's six edge types plus common_content", () => {
    const at = M3416.indexOf("CONSTRAINT trail_relations_relation_known CHECK (relation IN (");
    const body = M3416.slice(at, M3416.indexOf("))", at));
    const kinds = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(kinds, [...TRAIL_EDGE_TYPES, "common_content"]);
  });

  it("C6. nothing but migrations and tests names trail_relations — no reader, so no ranker reads it", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name === "test" || name === "migrations" || name === "node_modules" || name === "snapshots") continue;
          walk(p);
        // The table or its rebuild, as a name — not a path that merely contains it
        // (3416's filename is watched by census scripts, and names nothing).
        } else if (/\.(ts|mts|js|mjs)$/.test(name) && /\btrail_relations\b|rebuild_trail_relations/.test(readFileSync(p, "utf8"))) {
          hits.push(relative(SRC, p));
        }
      }
    };
    walk(SRC);
    assert.deepEqual(hits, []);
  });
});

describe("T — commitTrailProposal maps every answer of trail_propose", () => {
  const client = (answer: { data?: unknown; error?: unknown } | Error) => ({
    calls: [] as Array<[string, unknown]>,
    async rpc(fn: string, args: unknown) {
      this.calls.push([fn, args]);
      if (answer instanceof Error) throw answer;
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  });
  const input = { title: "Bangkok After Dark", destination: "bangkok", description: null, parentTrailId: null, proposerId: "u-1" };

  it("T1. the call is `trail_propose` with the five named arguments proposeTrail inserted before", async () => {
    const sc = client({ data: { outcome: "created", trail: { id: "t-1", slug: "bangkok-after-dark" } } });
    await commitTrailProposal(sc, input);
    assert.deepEqual(sc.calls, [["trail_propose", {
      p_title: "Bangkok After Dark", p_destination: "bangkok", p_description: null, p_parent_trail_id: null, p_created_by: "u-1",
    }]]);
  });

  it("T2. created, refused and invalid_parent are parsed", async () => {
    assert.equal((await commitTrailProposal(client({ data: { outcome: "created", trail: { id: "t-1" } } }), input)).kind, "created");
    const refused = await commitTrailProposal(client({ data: { outcome: "refused", suggestedParentTrailId: "p",
      refusals: [{ check: "duplicate_title_similarity", conflictsWith: "t-0", similarity: 1 }] } }), input);
    assert.deepEqual(refused, { kind: "refused", suggestedParentTrailId: "p",
      refusals: [{ check: "duplicate_title_similarity", conflictsWith: "t-0", similarity: 1 }] });
    assert.deepEqual(await commitTrailProposal(client({ data: { outcome: "invalid_parent" } }), input), { kind: "invalid_parent" });
  });

  it("T3. a missing function is `unavailable` — PostgREST's PGRST202, Postgres's 42883, a relation miss", async () => {
    for (const code of ["PGRST202", "42883", "42P01", "PGRST205"]) {
      assert.deepEqual(await commitTrailProposal(client({ error: { code, message: "x" } }), input), { kind: "unavailable" }, code);
    }
    assert.equal(isMissingProposalFunction({ code: "", message: "Could not find the function public.trail_propose(...) in the schema cache" }), true);
  });

  it("T4. any other error is an error, never `unavailable` (a 23505 stays a 23505 for proposeTrail's CHECK 1 mapping)", async () => {
    const r = await commitTrailProposal(client({ error: { code: "23505", message: "duplicate key" } }), input);
    assert.equal(r.kind, "error");
    assert.equal((r as any).error.code, "23505");
    assert.equal(isMissingProposalFunction({ code: "57014", message: "statement timeout" }), false);
  });

  it("T5. an answer of an unknown shape is an error, never a creation", async () => {
    for (const data of [null, {}, { outcome: "created" }, { outcome: "created", trail: { slug: "x" } },
      { outcome: "refused", refusals: [{ check: "made_up" }] }, { outcome: "maybe" }]) {
      assert.equal((await commitTrailProposal(client({ data }), input)).kind, "error", JSON.stringify(data));
    }
  });

  it("T6. a thrown client is an error, not an unhandled rejection", async () => {
    const r = await commitTrailProposal(client(new Error("socket hang up")), input);
    assert.equal(r.kind, "error");
  });
});

describe("V — verifyAttachSources", () => {
  type Answer = { data?: unknown[]; error?: unknown };
  const fakeSc = (tables: Record<string, Answer>) => ({
    reads: [] as string[],
    from(table: string) {
      this.reads.push(table);
      const answer = tables[table] ?? { data: [] };
      const q: any = { select: () => q, in: () => Promise.resolve({ data: answer.error ? null : answer.data ?? [], error: answer.error ?? null }) };
      return q;
    },
  });
  /** A stand-in for servableMembers: serves the candidates whose source ids are in `visible`. */
  const helper = (visible: string[], unreadAs: string | null = null, calls: MemberRow[][] = []) =>
    async (_sc: any, members: readonly MemberRow[], _viewer: string | null, _now?: number, unread?: Set<string>): Promise<ServableMember[]> => {
      calls.push([...members]);
      if (unreadAs) unread?.add(unreadAs);
      return members.filter((m) => visible.includes(m.source_id)).map((m) => ({ ...m, creatorId: null, clusterPlaceId: null }));
    };
  const label = (sourceType: string, sourceId: string) => ({ sourceType, sourceId, relationship: "supporting" });

  it("V1. the verifiable types are the four with a table; `itinerary` is refused without a read", async () => {
    assert.deepEqual([...VERIFIABLE_TRAIL_SOURCE_TYPES], ["post", "place", "event", "route"]);
    const sc = fakeSc({});
    const calls: MemberRow[][] = [];
    const v = await verifyAttachSources(sc, [label("itinerary", "i-1")], "u", helper([], null, calls));
    assert.deepEqual(v.reasons, ["unverifiable_source_type"]);
    assert.deepEqual(sc.reads, []);
    assert.deepEqual(calls, []);
  });

  it("V2. a place in EITHER table exists; in neither it is unknown", async () => {
    const sc = fakeSc({ discovery_places: { data: [{ id: "community" }] }, places: { data: [{ id: "canonical" }] } });
    const v = await verifyAttachSources(sc,
      [label("place", "community"), label("place", "canonical"), label("place", "nowhere")], "u",
      helper(["community", "canonical", "nowhere"]));
    assert.deepEqual(v.reasons, [null, null, "unknown_content"]);
    assert.deepEqual(v.refusals.map((r) => [r.sourceId, r.reason]), [["nowhere", "unknown_content"]]);
  });

  it("V3. a place table that cannot be read admits NOTHING — even a place the other table found — and reads no further", async () => {
    for (const broken of ["discovery_places", "places"]) {
      const sc = fakeSc({ discovery_places: { data: [{ id: "p" }] }, places: { data: [{ id: "p" }] }, [broken]: { error: { code: "57014" } } });
      const calls: MemberRow[][] = [];
      const v = await verifyAttachSources(sc, [label("place", "p"), label("post", "q")], "u", helper(["p", "q"], null, calls));
      assert.deepEqual(v.unreadable, [broken], broken);
      assert.deepEqual(calls, [], `${broken}: the request is already refused; no content source is read after it`);
    }
  });

  it("V4. what the visibility helper does not serve is `unknown_content` — the same word as absent", async () => {
    const v = await verifyAttachSources(fakeSc({}), [label("post", "seen"), label("post", "private"), label("event", "gone")], "u", helper(["seen"]));
    assert.deepEqual(v.reasons, [null, "unknown_content", "unknown_content"]);
  });

  it("V5. a read the helper reports as failed, or a helper that throws, admits NOTHING", async () => {
    const unread = await verifyAttachSources(fakeSc({}), [label("post", "p")], "u", helper(["p"], "blocks"));
    assert.deepEqual(unread.unreadable, ["blocks"]);
    const thrown = await verifyAttachSources(fakeSc({}), [label("post", "p")], "u", async () => { throw new Error("boom"); });
    assert.deepEqual(thrown.unreadable, ["sources"]);
  });

  it("V6. the helper judges the candidates AS THE ACTOR, contributed by the actor", async () => {
    const calls: MemberRow[][] = [];
    let viewer: string | null = "unset";
    await verifyAttachSources(fakeSc({}), [label("route", "r")], "actor-1",
      async (sc, members, v, now, unread) => { viewer = v; return helper(["r"], null, calls)(sc, members, v, now, unread); });
    assert.equal(viewer, "actor-1");
    assert.equal(calls[0]![0]!.contributor_id, "actor-1");
  });

  it("V7. refusals are reported in request order, with the ids the caller sent", async () => {
    const v = await verifyAttachSources(fakeSc({}),
      [label("post", "a"), label("itinerary", "b"), label("post", "c"), label("post", "d")], "u", helper(["c"]));
    assert.deepEqual(v.refusals.map((r) => [r.sourceType, r.sourceId, r.reason]), [
      ["post", "a", "unknown_content"], ["itinerary", "b", "unverifiable_source_type"], ["post", "d", "unknown_content"],
    ]);
  });
});

describe("S — DV-20: a Trail's identity folds stroke letters, and one place is one destination", () => {
  it("S1. a stroke letter is folded, not deleted: 'Đà Nẵng street food' and 'Da Nang street food' are one slug", () => {
    assert.equal(canonicalTrailSlug("Đà Nẵng street food"), "da-nang-street-food");
    assert.equal(canonicalTrailSlug("Đà Nẵng street food"), canonicalTrailSlug("Da Nang street food"));
    assert.deepEqual(
      ["Łódź Old Town", "Ørestad Nights", "Ħamrun Feast", "Ŧana Fjord", "Ðjúpivogur Coast", "ıstanbul Rooftops", "İstanbul Rooftops"].map(canonicalTrailSlug),
      ["lodz-old-town", "orestad-nights", "hamrun-feast", "tana-fjord", "djupivogur-coast", "istanbul-rooftops", "istanbul-rooftops"]);
    // The letters with neither decomposition nor stroke fold to their CLDR Latin-ASCII spelling.
    assert.equal(canonicalTrailSlug("Straße Food"), canonicalTrailSlug("Strasse Food"));
    assert.deepEqual(["ÆSIR Hall", "Cœur Walks", "Þingvellir Rift", "Ŋgoma Drums", "GROẞE Freiheit"].map(canonicalTrailSlug),
      ["aesir-hall", "coeur-walks", "thingvellir-rift", "nggoma-drums", "grosse-freiheit"]);
  });

  it("S2. the defect's own case: the second spelling is refused as the same Trail", () => {
    const existing = [{ id: "t-1", slug: canonicalTrailSlug("Đà Nẵng street food")!, title: "Đà Nẵng street food", destination: "đà nẵng" }];
    const r = canonicaliseTrailProposal({ title: "Da Nang street food", destination: "da nang" }, existing);
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => x.check === "duplicate_title_similarity" && x.conflictsWith === "t-1" && x.similarity === 1), JSON.stringify(r));
  });

  it("S3. 'Đà Nẵng', 'DA  NANG' and 'da nang' are one destination: the same-destination checks fire across spellings", () => {
    const existing = [{ id: "t-1", slug: "street-food-tour", title: "Street Food Tour", destination: "đà nẵng" }];
    for (const destination of ["da nang", "DA  NANG", "Đà Nẵng"]) {
      const r = canonicaliseTrailProposal({ title: "Street Food Walk", destination }, existing);
      assert.ok(r.refusals.some((x) => x.check === "semantic_overlap" && x.conflictsWith === "t-1"), `${destination}: ${JSON.stringify(r.refusals)}`);
    }
    // …and a different place is still a different destination.
    assert.equal(canonicaliseTrailProposal({ title: "Street Food Walk", destination: "hoi an" }, existing).ok, true);
  });

  it("S4. 3415's trail_letter_fold is lib/discoveryTrailFold's, and both the slug and the destination key apply it", () => {
    const body = M3415.slice(M3415.indexOf("FUNCTION public.trail_letter_fold"), M3415.indexOf("$fn$;", M3415.indexOf("FUNCTION public.trail_letter_fold")));
    const stroke = /translate\(p_text, '([^']+)', '([^']+)'\)/.exec(body);
    assert.ok(stroke, "trail_letter_fold has no stroke translate");
    const [from, to] = [[...stroke![1]!], [...stroke![2]!]];
    assert.equal(from.length, to.length);
    from.forEach((ch, i) => assert.equal(strokeFold(ch), to[i], ch));
    for (const ch of "đĐøØłŁħĦŧŦðÐıİ") assert.ok(from.includes(ch), `3415 does not stroke-fold ${ch}`);
    const letters = Object.fromEntries([...body.matchAll(/'([^'])', '([a-z]+)'\)/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(letters, { ...TRAIL_LETTER_FOLD });
    for (const ch of Object.keys(TRAIL_LETTER_FOLD)) assert.equal(trailLetterFold(ch), TRAIL_LETTER_FOLD[ch]);
    assert.match(M3415, /normalize\(public\.trail_letter_fold\(p_title\), NFKD\)/, "the slug does not fold letters first");
    assert.match(M3415, /v := public\.trail_letter_fold\(p_destination\);/, "the destination key does not fold letters first");
  });
});

describe("M — DV-25: a dismiss is not momentum, and not a §9 positive", () => {
  const NOW = Date.parse("2026-09-27T12:00:00.000Z");
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
  const served = (id: string, outcome: string, hoursAgo: number): MomentumRow =>
    ({ item_id: id, outcome, served_at: at(hoursAgo), outcome_at: outcome === "impression" ? null : at(hoursAgo - 0.25) });

  // A steady baseline (28 impressions over the prior 30 days, 2 per 48-hour window)
  // keeps every reading BELOW saturation, where an extra weight would show.
  const baseline = (id: string) => Array.from({ length: 28 }, (_, i) => served(id, "impression", 60 + i * 24));
  const recent = [1, 2, 3];

  it("M1. computeLocalMomentum: a place people dismissed has exactly the momentum of one nobody acted on", () => {
    const dismissed = computeLocalMomentum([...baseline("x"), ...recent.map((h) => served("x", "dismiss", h))], NOW).values.x;
    const ignored = computeLocalMomentum([...baseline("x"), ...recent.map((h) => served("x", "impression", h))], NOW).values.x;
    assert.ok(ignored! > 0 && ignored! < 1, `not vacuous: a surge below saturation (${ignored})`);
    assert.equal(dismissed, ignored, "a dismiss raised momentum");
    // Beside a save, a dismiss still adds nothing, and a save still adds its own weight.
    const mixed = computeLocalMomentum([...baseline("y"), served("y", "save", 1), ...[2, 3].map((h) => served("y", "dismiss", h))], NOW).values.y;
    const saveOnly = computeLocalMomentum([...baseline("y"), served("y", "save", 1), ...[2, 3].map((h) => served("y", "impression", h))], NOW).values.y;
    assert.ok(saveOnly! > ignored! && saveOnly! < 1, `the save still counts, below saturation (${saveOnly})`);
    assert.equal(mixed, saveOnly);
  });

  it("M2. a Trail's momentum (the same kernel, folded) does not rise on its members' dismisses", () => {
    const members = [{ trail_id: "T", source_type: "place", source_id: "p", relationship: "primary" as const, confidence: 0.8 }];
    const dismissed = trailMomentumFromRankEvents([...baseline("p"), ...recent.map((h) => served("p", "dismiss", h))], members, NOW).T;
    const ignored = trailMomentumFromRankEvents([...baseline("p"), ...recent.map((h) => served("p", "impression", h))], members, NOW).T;
    assert.ok(ignored! > 0 && ignored! < 1, `not vacuous (${ignored})`);
    assert.equal(dismissed, ignored);
  });

  it("M3. §9's exposure counts: a dismissed serve is an impression, never a positive response", () => {
    const counts = exposureCountsFrom([
      served("a", "dismiss", 1), served("a", "dismiss", 2), served("a", "impression", 3),
      served("b", "save", 1), served("b", "tap", 2), served("b", "dismiss", 3),
    ], new Set(["a", "b"]));
    assert.deepEqual(counts, { a: { impressions: 3, positives: 0 }, b: { impressions: 3, positives: 2 } });
  });
});
