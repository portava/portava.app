/**
 * §10's person visibility ladder and §23's `canSeeParticipant`, on the MEMORY
 * participant surface.
 *
 * Highlights/Memories Development Architecture Spec v1:
 *   §10  Person visibility ladder
 *        NAMED -> PROFILE_LINKED -> CREW_ONLY -> ANONYMOUS_COUNT -> HIDDEN
 *   §10  "Blocking and account deletion must suppress future social resurfacing
 *        and unlink profile identity as policy requires."
 *   §5   a participant is added "only after participant consent"
 *   §23  `canSeeParticipant(userId, memoryId, participantId)`
 *
 * Census ids: H77, H209.
 *
 * WHAT THESE TESTS ARE FOR. The ladder's five rungs and its renderer already
 * existed (services/highlights/highlightProjectionPolicy.ts) and are tested
 * there against a STORED rung from migration 2721, which is not applied. What
 * had no test — and no code — was the decision that picks a rung on a Memory
 * from data production actually has. Every fact these tests drive is a column
 * on the deployed schema: memory_tags.status, memories.visibility,
 * memories.trip_id, trip_members, blocks, profile_privacy_settings.
 *
 * Runtime: node:test + node:assert (no vitest, no real DB, no network)
 * Run: node --import tsx/esm --test src/test/memoryParticipantLadder.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  consentFromTagStatus,
  participantRungFor,
  discloseMemoryParticipant,
  projectParticipants,
  loadParticipantVisibility,
  factsFor,
  canSeeParticipant,
  type ParticipantFacts,
} from "../services/memory/memoryParticipantVisibility.js";
import { PERSON_VISIBILITY_LADDER } from "../services/highlights/highlightProjectionPolicy.js";

const MEM_ID   = "11111111-1111-1111-1111-111111111111";
const TRIP_ID  = "22222222-2222-2222-2222-222222222222";
const OWNER    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW     = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TAGGED   = "dddddddd-dddd-dddd-dddd-dddddddddddd";

/** A fact set with every axis at its most permissive, so each test moves one. */
function facts(over: Partial<ParticipantFacts> = {}): ParticipantFacts {
  return {
    memoryOwnerId: OWNER,
    memoryVisibility: "public",
    viewerId: STRANGER,
    participantId: TAGGED,
    tagStatus: "approved",
    viewerIsCrew: false,
    viewerBlocked: false,
    participantNameAllowed: false,
    ...over,
  };
}

/* ── A fake client, deliberately small ────────────────────────────────────── */

type Row = Record<string, any>;

function makeClient(state: Record<string, Row[]>, failing: Set<string> = new Set()) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const err = failing.has(table) ? { message: `${table} unreadable` } : null;
    const rows = () => (state[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      neq: (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return b; },
      limit: () => b,
      maybeSingle: async () => (err ? { data: null, error: err } : { data: rows()[0] ?? null, error: null }),
      then: (resolve: Function) => resolve(err ? { data: null, error: err } : { data: rows(), error: null }),
    };
    return b;
  }
  return { from } as any;
}

function baseState(): Record<string, Row[]> {
  return {
    memories: [{ id: MEM_ID, owner_id: OWNER, visibility: "public", trip_id: TRIP_ID, state: "published" }],
    memory_tags: [{ memory_id: MEM_ID, tagged_user_id: TAGGED, status: "approved" }],
    trips: [{ id: TRIP_ID, owner_id: OWNER }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: CREW, role: "member", status: "accepted" },
    ],
    blocks: [],
    profile_privacy_settings: [],
  };
}

/* ── consent ──────────────────────────────────────────────────────────────── */

describe("§5 participant consent, read off memory_tags.status", () => {
  it("maps the three statuses the write path actually produces", () => {
    // POST /memories inserts `pending`; PATCH tags writes `approved` / `removed`.
    assert.equal(consentFromTagStatus("approved"), "approved");
    assert.equal(consentFromTagStatus("pending"), "pending");
    assert.equal(consentFromTagStatus("removed"), "withdrawn");
  });

  it("anything else is `unknown`, and `unknown` is never consent", () => {
    for (const v of [null, undefined, "", "APPROVE", "yes", true, 1, {}, []]) {
      assert.equal(consentFromTagStatus(v as unknown), "unknown", `${JSON.stringify(v)} must not read as a status`);
    }
    // The distinction that matters: not-yet-answered is NOT the same as
    // answered-no, and neither is the same as unparseable.
    assert.notEqual(consentFromTagStatus("pending"), consentFromTagStatus("removed"));
  });
});

/* ── the ladder ───────────────────────────────────────────────────────────── */

describe("§10 person visibility ladder on a Memory — every rung is reachable", () => {
  it("NAMED: an approved participant who has opted in to their real name", () => {
    assert.equal(participantRungFor(facts({ participantNameAllowed: true })), "NAMED");
  });

  it("PROFILE_LINKED: an approved participant who has not opted in", () => {
    assert.equal(participantRungFor(facts()), "PROFILE_LINKED");
  });

  it("CREW_ONLY: the owner narrowed the audience to the trip, so the roster narrows with it", () => {
    assert.equal(participantRungFor(facts({ memoryVisibility: "trip_crew" })), "CREW_ONLY");
  });

  it("ANONYMOUS_COUNT: tagged, and has not consented yet", () => {
    // THE DEFECT THIS CLOSES. Before this, a `pending` tag shipped its
    // tagged_user_id to every viewer of the Memory — a person was profile-linked
    // to a Memory they had not agreed to be in.
    assert.equal(participantRungFor(facts({ tagStatus: "pending" })), "ANONYMOUS_COUNT");
  });

  it("HIDDEN: the participant removed their own tag", () => {
    // And NOT ANONYMOUS_COUNT. "Somebody was here, we won't say who" is still a
    // disclosure about a person who used the one exit the product gives them.
    assert.equal(participantRungFor(facts({ tagStatus: "removed" })), "HIDDEN");
  });

  it("every rung the ladder declares is produced by some reachable fact set", () => {
    const produced = new Set([
      participantRungFor(facts({ participantNameAllowed: true })),
      participantRungFor(facts()),
      participantRungFor(facts({ memoryVisibility: "trip_crew" })),
      participantRungFor(facts({ tagStatus: "pending" })),
      participantRungFor(facts({ tagStatus: "removed" })),
    ]);
    for (const rung of PERSON_VISIBILITY_LADDER) {
      assert.ok(produced.has(rung), `${rung} is declared by §10 and no fact set on this surface reaches it`);
    }
  });
});

describe("§10 the ladder's fixed order — the branches that outrank the others", () => {
  it("a block outranks approval, ownership and the viewer's own crew standing", () => {
    assert.equal(participantRungFor(facts({ viewerBlocked: true })), "HIDDEN");
    assert.equal(participantRungFor(facts({ viewerBlocked: true, participantNameAllowed: true })), "HIDDEN");
    assert.equal(participantRungFor(facts({ viewerBlocked: true, viewerId: OWNER })), "HIDDEN",
      "owning the Memory does not restore the identity of someone you have blocked");
    assert.equal(participantRungFor(facts({ viewerBlocked: true, memoryVisibility: "trip_crew", viewerIsCrew: true })), "HIDDEN");
  });

  it("a participant is never anonymised to themself, even before they consent", () => {
    assert.equal(participantRungFor(facts({ viewerId: TAGGED, tagStatus: "pending" })), "NAMED",
      "a person must be able to see the tag they are being asked to approve");
    assert.equal(participantRungFor(facts({ viewerId: TAGGED, memoryVisibility: "trip_crew" })), "NAMED");
  });

  it("the OWNER still sees a pending participant, because the owner typed the id", () => {
    assert.equal(participantRungFor(facts({ viewerId: OWNER, tagStatus: "pending" })), "PROFILE_LINKED");
    assert.equal(participantRungFor(facts({ viewerId: OWNER, tagStatus: "pending", participantNameAllowed: true })), "NAMED");
    // …but a WITHDRAWN participant is hidden from the owner too: removal is the
    // participant's decision and it binds the person who tagged them.
    assert.equal(participantRungFor(facts({ viewerId: OWNER, tagStatus: "removed" })), "HIDDEN");
  });

  it("FAIL CLOSED: no tag row, and an unparseable status, are both HIDDEN", () => {
    assert.equal(participantRungFor(facts({ tagStatus: null })), "HIDDEN");
    assert.equal(participantRungFor(facts({ tagStatus: "sort-of-approved" })), "HIDDEN");
    // Including for the owner: an unreadable consent state is not consent.
    assert.equal(participantRungFor(facts({ viewerId: OWNER, tagStatus: "sort-of-approved" })), "HIDDEN");
  });

  it("CREW_ONLY discloses to crew and hides from everyone else", () => {
    const person = { userId: TAGGED, handle: "dee", name: "Dee" };
    const crewView = discloseMemoryParticipant(person, facts({ memoryVisibility: "trip_crew", viewerIsCrew: true }));
    assert.equal(crewView.rung, "CREW_ONLY");
    assert.equal(crewView.disclosure.rung, "CREW_ONLY");
    assert.equal((crewView.disclosure as any).userId, TAGGED);

    const outsideView = discloseMemoryParticipant(person, facts({ memoryVisibility: "trip_crew", viewerIsCrew: false }));
    assert.equal(outsideView.rung, "CREW_ONLY", "the rung is a property of the Memory, not of the viewer");
    assert.equal(outsideView.disclosure.rung, "HIDDEN", "…but what a non-crew viewer receives is nothing");
  });

  it("ANONYMOUS_COUNT drops the user id, not just the name", () => {
    const d = discloseMemoryParticipant({ userId: TAGGED, handle: "dee", name: "Dee" }, facts({ tagStatus: "pending" }));
    assert.equal(d.disclosure.rung, "ANONYMOUS_COUNT");
    assert.equal((d.disclosure as any).userId, null, "a rung whose point is 'you do not learn who' cannot ship the id");
    assert.equal((d.disclosure as any).handle, null);
    assert.equal((d.disclosure as any).name, null);
  });
});

/* ── the list projection ──────────────────────────────────────────────────── */

describe("§10 the participant LIST a viewer receives", () => {
  const ctx = (over: Partial<Parameters<typeof projectParticipants>[0]> = {}) => ({
    memoryOwnerId: OWNER,
    memoryVisibility: "public" as string | null,
    viewerId: STRANGER,
    viewerIsCrew: false,
    blockedIds: new Set<string>(),
    nameAllowedIds: new Set<string>(),
    ...over,
  });

  it("a stranger gets the approved people, a count of the unconsented, and nothing of the withdrawn", () => {
    const out = projectParticipants(ctx(), [
      { tagged_user_id: "p-approved-1", status: "approved" },
      { tagged_user_id: "p-approved-2", status: "approved" },
      { tagged_user_id: "p-pending-1", status: "pending" },
      { tagged_user_id: "p-pending-2", status: "pending" },
      { tagged_user_id: "p-removed", status: "removed" },
    ]);
    assert.deepEqual(out.participants.map((p) => p.userId), ["p-approved-1", "p-approved-2"]);
    assert.equal(out.anonymousCount, 2);
    // The asymmetry is the whole reason there are two rungs: folding the
    // withdrawn person into the count would leak their withdrawal as an
    // arithmetic difference between two viewers' counts.
    assert.ok(!JSON.stringify(out).includes("p-removed"), "a withdrawn participant leaves no trace at all");
    assert.equal(out.strictestApplied, "HIDDEN");
  });

  it("the OWNER's list is not narrowed by consent — they still manage their pending tags", () => {
    const out = projectParticipants(ctx({ viewerId: OWNER }), [
      { tagged_user_id: "p-approved-1", status: "approved" },
      { tagged_user_id: "p-pending-1", status: "pending" },
    ]);
    assert.deepEqual(out.participants.map((p) => p.userId), ["p-approved-1", "p-pending-1"]);
    assert.deepEqual(out.participants.map((p) => p.status), ["approved", "pending"]);
    assert.equal(out.anonymousCount, 0);
  });

  it("a blocked participant is dropped and is not counted either", () => {
    const out = projectParticipants(ctx({ blockedIds: new Set(["p-blocked"]) }), [
      { tagged_user_id: "p-approved-1", status: "approved" },
      { tagged_user_id: "p-blocked", status: "approved" },
    ]);
    assert.deepEqual(out.participants.map((p) => p.userId), ["p-approved-1"]);
    assert.equal(out.anonymousCount, 0, "a count would still tell the viewer the blocked person was there");
  });

  it("the name rides on the opt-in, per participant, not per list", () => {
    const profiles = new Map([
      ["p-opted", { name: "Opted In", handle: "opted" }],
      ["p-not", { name: "Not Opted", handle: "not" }],
    ]);
    const out = projectParticipants(ctx({ nameAllowedIds: new Set(["p-opted"]) }), [
      { tagged_user_id: "p-opted", status: "approved" },
      { tagged_user_id: "p-not", status: "approved" },
    ], profiles);
    assert.equal(out.participants.find((p) => p.userId === "p-opted")!.name, "Opted In");
    assert.equal(out.participants.find((p) => p.userId === "p-opted")!.rung, "NAMED");
    assert.equal(out.participants.find((p) => p.userId === "p-not")!.name, null);
    assert.equal(out.participants.find((p) => p.userId === "p-not")!.rung, "PROFILE_LINKED");
    assert.equal(out.participants.find((p) => p.userId === "p-not")!.handle, "not",
      "PROFILE_LINKED keeps the @handle — that is what makes it a rung above CREW_ONLY, not below it");
  });
});

/* ── §23 canSeeParticipant, the I/O predicate ─────────────────────────────── */

describe("§23 canSeeParticipant(userId, memoryId, participantId)", () => {
  it("answers a rung for a stranger from the deployed tables alone", async () => {
    const sc = makeClient(baseState());
    assert.equal(await canSeeParticipant(sc, STRANGER, MEM_ID, TAGGED), "PROFILE_LINKED");
  });

  it("reads the opt-in out of profile_privacy_settings", async () => {
    const state = baseState();
    state.profile_privacy_settings = [{ user_id: TAGGED, show_real_name: true }];
    assert.equal(await canSeeParticipant(makeClient(state), STRANGER, MEM_ID, TAGGED), "NAMED");
  });

  it("reads the consent state out of memory_tags", async () => {
    const state = baseState();
    state.memory_tags = [{ memory_id: MEM_ID, tagged_user_id: TAGGED, status: "pending" }];
    assert.equal(await canSeeParticipant(makeClient(state), STRANGER, MEM_ID, TAGGED), "ANONYMOUS_COUNT");
  });

  it("reads the audience out of memories.visibility", async () => {
    const state = baseState();
    state.memories = [{ id: MEM_ID, owner_id: OWNER, visibility: "trip_crew", trip_id: TRIP_ID, state: "published" }];
    assert.equal(await canSeeParticipant(makeClient(state), CREW, MEM_ID, TAGGED), "CREW_ONLY");
  });

  it("a person who was never tagged is HIDDEN, not an error", async () => {
    assert.equal(await canSeeParticipant(makeClient(baseState()), STRANGER, MEM_ID, CREW), "HIDDEN");
  });

  it("FAIL CLOSED on every read it makes, one table at a time", async () => {
    // supabase-js RESOLVES on a database error, so each of these would otherwise
    // read as a plausible empty answer rather than as a failure.
    for (const table of ["memories", "memory_tags", "blocks"]) {
      const sc = makeClient(baseState(), new Set([table]));
      assert.equal(await canSeeParticipant(sc, STRANGER, MEM_ID, TAGGED), "HIDDEN",
        `an unreadable ${table} must not disclose a participant`);
    }
  });

  it("an unreadable trip_members makes a crew-scoped Memory disclose nobody", async () => {
    const state = baseState();
    state.memories = [{ id: MEM_ID, owner_id: OWNER, visibility: "trip_crew", trip_id: TRIP_ID, state: "published" }];
    const sc = makeClient(state, new Set(["trip_members"]));
    const memoryRow = state.memories[0] as { owner_id: string; visibility?: string | null; trip_id?: string | null };
    const ctx = await loadParticipantVisibility(sc, memoryRow, CREW, [TAGGED]);
    assert.equal(ctx.viewerIsCrew, false, "a failed membership read is not membership");
    const rung = participantRungFor(factsFor(ctx, TAGGED, "approved"));
    assert.equal(rung, "CREW_ONLY");
    assert.equal(
      discloseMemoryParticipant({ userId: TAGGED, handle: null, name: null }, factsFor(ctx, TAGGED, "approved")).disclosure.rung,
      "HIDDEN",
    );
  });

  it("the error BINDING is what refuses, not the null it happens to arrive with", async () => {
    // FOUND BY A SURVIVING MUTATION. Deleting `if (error) return "HIDDEN"` from
    // the `memories` read broke nothing, because the fake — like supabase-js on
    // an ordinary failure — returns `data: null` beside the error, and the very
    // next line refuses a null Memory anyway. A guard whose red cannot be
    // produced is a comment, so this drives the one shape that separates them:
    // a client that answers with a row AND an error. The row is a live, public,
    // approved Memory; only the binding can refuse it.
    const state = baseState();
    const lying: any = {
      from: (name: string) =>
        name === "memories"
          ? { select: () => ({ eq: () => ({ neq: () => ({ maybeSingle: async () => ({ data: state.memories[0], error: { message: "08006 connection failure" } }) }) }) }) }
          : makeClient(state).from(name),
    };
    assert.equal(await canSeeParticipant(lying, STRANGER, MEM_ID, TAGGED), "HIDDEN",
      "a read that reported an error did not establish this Memory, whatever it also returned");

    const lyingTags: any = {
      from: (name: string) =>
        name === "memory_tags"
          ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tagged_user_id: TAGGED, status: "approved" }, error: { message: "08006 connection failure" } }) }) }) }) }
          : makeClient(state).from(name),
    };
    assert.equal(await canSeeParticipant(lyingTags, STRANGER, MEM_ID, TAGGED), "HIDDEN",
      "an errored memory_tags read cannot prove consent, whatever status it also returned");
  });

  it("a deleted Memory discloses nobody", async () => {
    const state = baseState();
    state.memories = [{ id: MEM_ID, owner_id: OWNER, visibility: "public", trip_id: TRIP_ID, state: "deleted" }];
    assert.equal(await canSeeParticipant(makeClient(state), STRANGER, MEM_ID, TAGGED), "HIDDEN");
  });
});
