/**
 * The pure halves of b58 lane HM-A3 (census-highlights-memories H262 H265
 * H120 H123 H124 H266), driven directly:
 *   compass/memoryCompassTruth.ts       name equality, named-place resolution,
 *                                       literal handles, the participant-count
 *                                       ladder, the merge audience rule
 *   compass/memoryFallbackRenderer.ts   §28.17's deterministic renderer
 *   services/memoryCertification/invariants.ts  the §28.3 developer invariant
 *
 * The behaviour through the real dispatcher is memoryCompassTruth.test.ts; the
 * route is compassMemoryFallbackRoute.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryCompassTruthUnits.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MEMORY_MERGE_SPLIT_FLAG,
  PROPOSE_MERGE_MAX_ABSORBED,
  PROPOSE_SPLIT_MAX_ITEMS,
  countParticipantsUnderLadder,
  foldEntityName,
  mergeAudiencesDiffer,
  readMemoryProvenance,
  resolveExactHandle,
  resolveNamedPlace,
} from "../compass/memoryCompassTruth.js";
import { MEMORY_FALLBACK_RENDERER_VERSION, renderMemoryToolFallback } from "../compass/memoryFallbackRenderer.js";
import { MEMORY_MERGE_SPLIT_FLAG as ROUTE_FLAG, MERGE_MAX_ABSORBED, SPLIT_MAX_ITEMS } from "../routes/memoryGraph.js";
import { DEVELOPER_INVARIANT_IDS, runDeveloperInvariants } from "../services/memoryCertification/invariants.js";
import type { ParticipantVisibilityContext } from "../services/memory/memoryParticipantVisibility.js";

const SPEC_PATH = new URL("../../../../docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt", import.meta.url).pathname;

describe("foldEntityName — equal after NFC, whitespace and case folding, and nothing more", () => {
  it("folds what is the same name", () => {
    assert.equal(foldEntityName("  New   YORK "), "new york");
    assert.equal(foldEntityName("Huế"), foldEntityName("Huế".normalize("NFD")));
    assert.equal(foldEntityName("Straße"), foldEntityName("STRASSE"));
  });
  it("does not fold what is a different name", () => {
    assert.notEqual(foldEntityName("York"), foldEntityName("New York"));
    assert.notEqual(foldEntityName("Da Nang"), foldEntityName("Đà Nẵng"), "accent stripping would be a substitute");
    assert.equal(foldEntityName(null), "");
    assert.equal(foldEntityName(42), "");
  });
});

describe("resolveNamedPlace", () => {
  const row = (city: string | null, country: string | null) => ({ location_city: city, location_country: country });
  const ny = row("New York", "United States");
  const pdxUs = row("Portland", "United States");
  const pdxJm = row("Portland", "Jamaica");
  const pdxNone = row("Portland", null);
  const hidden = row(null, null);

  it("NOT_ASKED admits every row", () => {
    const o = resolveNamedPlace([ny, hidden], { city: null, country: null });
    assert.equal(o.resolution, "NOT_ASKED");
    assert.ok(o.admits(ny) && o.admits(hidden));
  });
  it("UNRESOLVED admits nothing, and a row whose city §10 withheld is not matched by anything", () => {
    const o = resolveNamedPlace([ny, hidden], { city: "York", country: null });
    assert.equal(o.resolution, "UNRESOLVED");
    assert.ok(!o.admits(ny) && !o.admits(hidden));
  });
  it("AMBIGUOUS needs two RECORDED countries; an unrecorded country does not make a name ambiguous", () => {
    assert.equal(resolveNamedPlace([pdxUs, pdxJm], { city: "Portland", country: null }).resolution, "AMBIGUOUS");
    const one = resolveNamedPlace([pdxUs, pdxNone], { city: "Portland", country: null });
    assert.equal(one.resolution, "RESOLVED");
    assert.ok(one.admits(pdxUs) && one.admits(pdxNone));
  });
  it("AMBIGUOUS lists every group, including the unrecorded-country one, and admits nothing", () => {
    const o = resolveNamedPlace([pdxUs, pdxJm, pdxNone], { city: "portland", country: null });
    assert.equal(o.resolution, "AMBIGUOUS");
    assert.equal(o.candidates.length, 3);
    assert.ok(![pdxUs, pdxJm, pdxNone].some((r) => o.admits(r)));
  });
  it("a country settles it, and a row with no recorded country is NOT admitted under a named country", () => {
    const o = resolveNamedPlace([pdxUs, pdxJm, pdxNone], { city: "Portland", country: "United States" });
    assert.equal(o.resolution, "RESOLVED");
    assert.ok(o.admits(pdxUs) && !o.admits(pdxJm) && !o.admits(pdxNone));
  });
  it("a country alone resolves by equality too", () => {
    const o = resolveNamedPlace([ny, pdxJm], { city: null, country: "jamaica" });
    assert.equal(o.resolution, "RESOLVED");
    assert.ok(o.admits(pdxJm) && !o.admits(ny));
  });
});

describe("resolveExactHandle — a literal pattern, checked equal in code", () => {
  function profiles(rows: Array<{ id: string; handle: string }>, opts: { error?: boolean; loose?: boolean } = {}) {
    const patterns: string[] = [];
    const sc: any = {
      from(_t: string) {
        let pat = "";
        const q: any = {
          select() { return q; },
          ilike(_c: string, p: string) { pat = p; patterns.push(p); return q; },
          limit() { return q; },
          then(res: any) {
            if (opts.error) return res({ data: null, error: { message: "down" } });
            if (opts.loose) return res({ data: rows, error: null }); // a database that ignored the pattern
            // PostgREST semantics: an unescaped `_` is one character.
            let re = "";
            for (let i = 0; i < pat.length; i++) {
              const c = pat[i]!;
              if (c === "\\") { re += pat[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
              re += c === "_" ? "." : c === "%" ? ".*" : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            }
            const rx = new RegExp(`^${re}$`, "i");
            return res({ data: rows.filter((r) => rx.test(r.handle)), error: null });
          },
        };
        return q;
      },
    };
    return { sc, patterns };
  }
  it("escapes `_` so it matches only itself", async () => {
    const { sc, patterns } = profiles([{ id: "1", handle: "john" }, { id: "2", handle: "jo_n" }]);
    assert.deepEqual(await resolveExactHandle(sc, "@jo_n"), { state: "found", id: "2", handle: "jo_n" });
    assert.deepEqual(patterns, ["jo\\_n"]);
    const { sc: sc2 } = profiles([{ id: "1", handle: "john" }]);
    assert.equal((await resolveExactHandle(sc2, "jo_n")).state, "no_such_handle");
  });
  it("checks equality in code too: a database answering a looser pattern still never yields a different handle", async () => {
    const { sc } = profiles([{ id: "1", handle: "john" }], { loose: true });
    assert.equal((await resolveExactHandle(sc, "jo_n")).state, "no_such_handle");
  });
  it("refuses wildcard-shaped input without querying at all", async () => {
    for (const raw of ["c*", "%arl", "a b", "x\\y", ""]) {
      const { sc, patterns } = profiles([{ id: "1", handle: "carl" }]);
      assert.equal((await resolveExactHandle(sc, raw)).state, "no_such_handle", raw);
      assert.deepEqual(patterns, [], `${raw} reached the database`);
    }
  });
  it("two profiles equal to the handle (a legacy case pair) is `unavailable`, not a pick; a read error likewise", async () => {
    const { sc } = profiles([{ id: "1", handle: "Carl" }, { id: "2", handle: "carl" }]);
    assert.deepEqual(await resolveExactHandle(sc, "carl"), { state: "unavailable" });
    const { sc: down } = profiles([], { error: true });
    assert.deepEqual(await resolveExactHandle(down, "carl"), { state: "unavailable" });
  });
});

describe("countParticipantsUnderLadder — the count follows the ladder, and an unreadable ceiling withholds it", () => {
  const ctx = (over: Partial<ParticipantVisibilityContext> = {}): ParticipantVisibilityContext => ({
    memoryOwnerId: "owner", memoryVisibility: "public", viewerId: "viewer", viewerIsCrew: false,
    blockedIds: new Set(), nameAllowedIds: new Set(), ...over,
  });
  const tags = [
    { tagged_user_id: "p1", status: "approved" },
    { tagged_user_id: "p2", status: "approved" },
    { tagged_user_id: "p3", status: "pending" },
    { tagged_user_id: "p4", status: "removed" },
  ];
  it("a third party: approved are confirmed, pending is an anonymous count, withdrawn is nobody", () => {
    assert.deepEqual(countParticipantsUnderLadder(ctx(), tags), { ok: true, confirmed: 2, unconfirmed: 0, unidentified: 1 });
  });
  it("a block either way removes that person from every count", () => {
    assert.deepEqual(countParticipantsUnderLadder(ctx({ blockedIds: new Set(["p1", "p3"]) }), tags), { ok: true, confirmed: 1, unconfirmed: 0, unidentified: 0 });
  });
  it("crew-scoped people are not counted for a viewer outside the crew", () => {
    assert.deepEqual(countParticipantsUnderLadder(ctx({ memoryVisibility: "trip_crew" }), tags), { ok: true, confirmed: 0, unconfirmed: 0, unidentified: 1 });
  });
  it("the owner sees their own pending tags as unconfirmed", () => {
    assert.deepEqual(countParticipantsUnderLadder(ctx({ viewerId: "owner" }), tags), { ok: true, confirmed: 2, unconfirmed: 1, unidentified: 0 });
  });
  it("MEM-POLICY's ceiling, once on the context: UNREADABLE withholds the count rather than counting HIDDEN as zero", () => {
    const withCeiling = { ...ctx(), personCeilings: { state: "unreadable", detail: "down" } } as unknown as ParticipantVisibilityContext;
    assert.equal(countParticipantsUnderLadder(withCeiling, tags).ok, false);
    const readable = { ...ctx(), personCeilings: { state: "absent", detail: "no table" } } as unknown as ParticipantVisibilityContext;
    assert.equal(countParticipantsUnderLadder(readable, tags).ok, true);
  });
});

describe("readMemoryProvenance — owner only, scoped by owner, bounded", () => {
  it("never reads for a viewer who is not the owner", async () => {
    let touched = 0;
    const sc: any = { from() { touched++; throw new Error("must not read"); } };
    const r = await readMemoryProvenance(sc, { id: "m", owner_id: "owner" }, "someone-else");
    assert.equal(r.store, "owner_only");
    assert.equal(touched, 0);
  });
  it("a throw is `unavailable`, not absent", async () => {
    const sc: any = { from() { throw new Error("socket closed"); } };
    assert.equal((await readMemoryProvenance(sc, { id: "m", owner_id: "o" }, "o")).store, "unavailable");
  });
});

describe("H124 — the proposal tools mirror the routes they hand off to", () => {
  it("the flag and the bounds are the routes' own", () => {
    assert.equal(MEMORY_MERGE_SPLIT_FLAG, ROUTE_FLAG);
    assert.equal(PROPOSE_MERGE_MAX_ABSORBED, MERGE_MAX_ABSORBED);
    assert.equal(PROPOSE_SPLIT_MAX_ITEMS, SPLIT_MAX_ITEMS);
  });
  it("the audience rule is 3676's: lists as sets, the trip only under trip_crew", () => {
    const base = { state: "published", visibility: "custom", allowed_user_ids: ["a", "b"], hidden_user_ids: [], trip_id: "t1" };
    assert.equal(mergeAudiencesDiffer([base, { ...base, allowed_user_ids: ["b", "a", "a"], trip_id: "t2" }]), false);
    assert.equal(mergeAudiencesDiffer([base, { ...base, allowed_user_ids: ["a"] }]), true);
    assert.equal(mergeAudiencesDiffer([base, { ...base, state: "draft" }]), true);
    const crew = { ...base, visibility: "trip_crew" };
    assert.equal(mergeAudiencesDiffer([crew, { ...crew, trip_id: "t2" }]), true);
  });
});

describe("H266 §28.17 — renderMemoryToolFallback", () => {
  const fact = (claim: string) => ({ memory_id: "m", title: "<portava:ugc>t</portava:ugc>", historical: { claim, establishes_current_status: false } });

  it("renders nothing when no memory tool answered, so other turns keep their own fallback", () => {
    assert.equal(renderMemoryToolFallback([]), null);
    assert.equal(renderMemoryToolFallback([{ name: "search_places", result: { places: [] } }]), null);
    // A Telegraph refusal has the same { authorized: false } shape and is NOT about the user's Memories.
    assert.equal(renderMemoryToolFallback([{ name: "telegraph_get_conversation_context", result: { authorized: false, reason: "Not a participant." } }]), null);
    assert.equal(renderMemoryToolFallback(null), null);
  });

  it("renders each Memory from the app-composed claim, and closes as historical", () => {
    const r = renderMemoryToolFallback([{ name: "memory_search", result: { memories: [fact('Recorded: "Dragon Bridge" — Da Nang, Vietnam, on 2026-03-04.')] } }])!;
    assert.equal(r.renderer, MEMORY_FALLBACK_RENDERER_VERSION);
    assert.deepEqual(r.rendered_tools, ["memory_search"]);
    assert.match(r.text, /Recorded: "Dragon Bridge" — Da Nang, Vietnam, on 2026-03-04\./);
    assert.match(r.text, /historical records/);
    assert.doesNotMatch(r.text, /portava:ugc/);
  });

  it("says UNRESOLVED and AMBIGUOUS as such, and never lists a substitute", () => {
    const un = renderMemoryToolFallback([{ name: "memory_search", result: { resolution: "UNRESOLVED", asked: { city: "York", country: null }, memories: [] } }])!;
    assert.match(un.text, /Nothing in your Memories is "York"/);
    const amb = renderMemoryToolFallback([{ name: "memory_get_place_history", result: { resolution: "AMBIGUOUS", asked: { city: "Portland" }, candidates: [{ city: "Portland", country: "Jamaica" }, { city: "Portland", country: null }], visits: [] } }])!;
    assert.match(amb.text, /Several places in your Memories are called "Portland" \(Portland, Jamaica; Portland, country not recorded\)/);
  });

  it("a refusal renders only its first sentence — never the instruction to the model", () => {
    const r = renderMemoryToolFallback([{ name: "memory_get", result: { authorized: false, reason: "The privacy settings on these Memories could not be checked right now, so none of them is shared with the assistant. Say that it could not be looked up." } }])!;
    assert.match(r.text, /could not be checked right now/);
    assert.doesNotMatch(r.text, /Say that/);
  });

  it("a draft's model-supplied fields are not rendered; only that nothing was saved", () => {
    const r = renderMemoryToolFallback([{ name: "memory_create_draft", result: { draft: { fields: { title: "MODEL WORDS" } }, writes_nothing: true } }])!;
    assert.doesNotMatch(r.text, /MODEL WORDS/);
    assert.match(r.text, /Nothing was saved/);
  });

  it("place history renders the visits and nothing about the present", () => {
    const r = renderMemoryToolFallback([{ name: "memory_get_place_history", result: { visits: [fact('Recorded: "Bar" — Hanoi.')], current_world: { available: true, statement: "Bar is open right now." } } }])!;
    assert.doesNotMatch(r.text, /open right now/);
  });

  it("shared Memories keep confirmed and unconfirmed apart", () => {
    const r = renderMemoryToolFallback([{ name: "memory_get_shared", result: { person: "carl", memories: [fact("A")], unconfirmed_participation: [fact("B")] } }])!;
    assert.match(r.text, /A \(with @carl, who confirmed being there\)/);
    assert.match(r.text, /B \(@carl was tagged and has not confirmed\)/);
  });

  it("evidence renders counts it was given and withholds the ones it was not", () => {
    const withheld = renderMemoryToolFallback([{ name: "memory_get_evidence", result: { attached_artifacts: null, confirmed_participants: null, participants_unavailable: true, evidence_store: "unavailable" } }])!;
    assert.match(withheld.text, /could not be looked up/);
    assert.doesNotMatch(withheld.text, /\b0 person/);
    const present = renderMemoryToolFallback([{ name: "memory_get_evidence", result: { attached_artifacts: [{}], confirmed_participants: 2, evidence_store: "present", provenance: [{ records: [{ truth_level: "observed" }, { truth_level: "asserted" }, { truth_level: "observed" }] }] } }])!;
    assert.match(present.text, /2 observed, 1 asserted/);
    assert.match(present.text, /not proof/);
  });

  it("stays bounded", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: "memory_search", result: { memories: Array.from({ length: 10 }, () => fact(`Recorded: "${"x".repeat(80)} ${i}".`)) } }));
    const r = renderMemoryToolFallback(many)!;
    assert.ok(r.text.length <= 2000);
    assert.match(r.text, /historical records/);
  });
});

describe("§28.3 developer invariant (census H262)", () => {
  it("holds, and its sentence is the spec's own", async () => {
    const out = await runDeveloperInvariants();
    assert.deepEqual(out.map((o) => o.id), [...DEVELOPER_INVARIANT_IDS]);
    const o = out[0]!;
    assert.equal(o.status, "HELD", o.detail);
    assert.equal(o.census_id, "H262");
    const line = readFileSync(SPEC_PATH, "utf8").split("\n")[o.spec_line - 1]!;
    assert.equal(line.replace(/^\d+\.\s*/, "").trim(), o.spec_text);
    assert.match(o.detail, /CEILING:/);
  });
});
