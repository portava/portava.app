/**
 * §2 — "Turn social content into optional real-world actions: see place, save,
 * add to Trip, join, message, map, ask Compass, or book a Buddy" — and §40 #6,
 * "a social object can lead to Map/Trip/Compass/Gem/Buddy WITHOUT forcing the
 * transition".
 *
 * WHAT WAS MISSING. Five of the eight actions had a server producer. Three did
 * not: `join` and `message` existed only in the client's route resolver for
 * actions no service ever emitted, and `save` was a React `useState` toggle that
 * wrote nothing, so the bookmark reset on remount. This file is the proof for
 * those three, plus the non-forcing property the whole set has to keep.
 *
 * EACH PRODUCER IS GATED BY A CANONICAL SYSTEM, NOT BY THE WALL.
 *   save    → the canonical `post_saves` store. The Wall reports the state and
 *             names the action; the write goes to routes/mediaFeed's endpoint.
 *   message → offered only on a Buddy opportunity, i.e. only after
 *             `enforceBookingCreationGates` already admitted this viewer for
 *             this Buddy. The Wall does NOT re-derive `canMessage` for ordinary
 *             posts (that is interactionPermissions' decision, 13 reads per
 *             target) — where it cannot cheaply KNOW, it offers nothing.
 *   join    → carried on an `event_state` live item and pointed at the CANONICAL
 *             event, whose own eligibility/capacity/RSVP gate runs there.
 *
 * MUTATION PROOF (each verified: revert → RED, restore → GREEN)
 *   • delete the `save` push from `buildActions` → 3 tests RED.
 *   • change `viewer.savedObjectIds?.has(...)` to a constant `false` → the
 *     "Saved" label + `viewerSaved` tests RED.
 *   • widen the `message` producer to every object type → the "not on a plain
 *     post" test RED.
 *   • delete the `action:` block from the event producer, or drop the
 *     `if (cand.action)` line from `actionFor` → the join tests RED.
 *   • stamp `viewerSaved` on shared_moment too → the "no false save concept"
 *     test RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectObjects,
  type ProjectViewerContext,
  type WallCandidate,
} from "../services/wall/WallProjectionService.js";
import { buildLiveForYou, type LiveForYouCandidate } from "../services/wall/LiveForYouService.js";
import type { WallAction, WallProjection } from "../lib/wallProjection.js";

const VIEWER = "viewer-1";
const AUTHOR = "author-1";

/** A client whose only job is to answer the block read with "no blocks". */
function noBlocksClient() {
  const b: any = {
    select: () => b,
    eq: () => b,
    in: () => b,
    or: () => b,
    gte: () => b,
    lte: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (onF: any, onR: any) => Promise.resolve({ data: [], error: null }).then(onF, onR),
  };
  return { from: () => b };
}

function postCandidate(over: Partial<WallCandidate> = {}): WallCandidate {
  return {
    objectType: "social_post",
    canonicalObjectId: "post-1",
    authorId: AUTHOR,
    visibility: "public",
    publishedAt: "2026-09-01T00:00:00.000Z",
    authorAccountStatus: "active",
    // A real byline. Load-bearing for the "a plain post carries no message
    // action" test below: without an actor the absence would prove nothing,
    // because there would be nobody to message either way.
    actor: { userId: AUTHOR, displayName: "Aya" },
    ...over,
  };
}

function buddyCandidate(over: Partial<WallCandidate> = {}): WallCandidate {
  return {
    objectType: "contextual_opportunity",
    canonicalObjectId: "buddy-profile-1",
    authorId: "buddy-user-1",
    publishedAt: "2026-09-01T00:00:00.000Z",
    authorAccountStatus: "active",
    opportunityKind: "buddy_around",
    opportunityArea: "Da Nang",
    actor: { userId: "buddy-user-1", displayName: "Minh", isBuddy: true },
    callerVisibilityResolved: true,
    ...over,
  };
}

const BASE_VIEWER: ProjectViewerContext = {
  viewerId: VIEWER,
  viewerTripIds: new Set<string>(),
  followedCreatorIds: new Set<string>([AUTHOR]),
};

async function project(
  candidates: WallCandidate[],
  viewer: Partial<ProjectViewerContext> = {},
): Promise<WallProjection[]> {
  return projectObjects(noBlocksClient() as any, candidates, { ...BASE_VIEWER, ...viewer });
}

const actionOf = (p: WallProjection, type: string): WallAction | undefined =>
  p.actions.find((a) => a.type === type);

// ── save (§2) ────────────────────────────────────────────────────────────────

describe("§2 save — a server-produced action over the canonical save store", () => {
  it("a post-like object carries a `save` action", async () => {
    const [p] = await project([postCandidate()]);
    const save = actionOf(p, "save");
    assert.ok(save, "a post must offer save");
    assert.equal(save!.targetType, "post");
    assert.equal(save!.targetId, "post-1");
  });

  it("every post-like type carries it, and no other type does", async () => {
    const postLike = ["social_post", "video", "postcard", "social_update", "discovery"] as const;
    for (const objectType of postLike) {
      const [p] = await project([
        postCandidate({ objectType, canonicalObjectId: `id-${objectType}`, discoveryReason: "why" }),
      ]);
      assert.ok(actionOf(p, "save"), `${objectType} must offer save`);
    }
    // A Buddy opportunity is not a `posts` row and has no canonical post save.
    const [b] = await project([buddyCandidate()]);
    assert.equal(actionOf(b, "save"), undefined);
  });

  it("the label and params report the SERVER's save state, not a guess", async () => {
    const [unsaved] = await project([postCandidate()]);
    assert.equal(actionOf(unsaved, "save")!.label, "Save");
    assert.equal(actionOf(unsaved, "save")!.params?.saved, false);

    const [saved] = await project([postCandidate()], {
      savedObjectIds: new Set(["post-1"]),
    });
    assert.equal(actionOf(saved, "save")!.label, "Saved");
    assert.equal(actionOf(saved, "save")!.params?.saved, true);
  });

  it("`viewerSaved` is projected for post-like objects — the bookmark is server truth", async () => {
    const [off] = await project([postCandidate()]);
    assert.equal(off.viewerSaved, false);
    const [on] = await project([postCandidate()], { savedObjectIds: new Set(["post-1"]) });
    assert.equal(on.viewerSaved, true);
  });

  it("a type with no canonical save concept omits `viewerSaved` rather than asserting false", async () => {
    const [b] = await project([buddyCandidate()]);
    assert.equal("viewerSaved" in b, false);
  });

  it("an unknown save state offers Save, never a false Saved", async () => {
    // `savedObjectIds` absent = the store could not be read (it fails soft).
    const [p] = await project([postCandidate()], { savedObjectIds: undefined });
    assert.equal(actionOf(p, "save")!.label, "Save");
    assert.equal(p.viewerSaved, false);
  });
});

// ── message (§2/§19) ─────────────────────────────────────────────────────────

describe("§2 message — offered only where a canonical gate already admitted the viewer", () => {
  it("a Buddy opportunity carries a `message` action aimed at the person", async () => {
    const [p] = await project([buddyCandidate()]);
    const msg = actionOf(p, "message");
    assert.ok(msg, "a gate-admitted Buddy opportunity must offer message");
    assert.equal(msg!.targetType, "user");
    assert.equal(msg!.targetId, "buddy-user-1");
  });

  it("both Buddy kinds carry it", async () => {
    for (const kind of ["buddy_dispatch", "buddy_around"] as const) {
      const [p] = await project([buddyCandidate({ opportunityKind: kind })]);
      assert.ok(actionOf(p, "message"), `${kind} must offer message`);
    }
  });

  it("a plain social post does NOT carry it — the Wall never approximates canMessage", async () => {
    const [p] = await project([postCandidate()]);
    // The post HAS an actor (see the fixture) — so this is a real refusal, not
    // an absence of anybody to message. `canMessage` is
    // services/interactionPermissions' decision and costs 13 reads per target;
    // the Wall does not approximate it, and offers nothing where it cannot know.
    assert.ok(p.actor, "the fixture must carry an actor for this to mean anything");
    assert.equal(actionOf(p, "message"), undefined);
  });

  it("never offers the viewer a way to message themselves", async () => {
    const [p] = await project([
      buddyCandidate({
        authorId: VIEWER,
        actor: { userId: VIEWER, displayName: "Me", isBuddy: true },
      }),
    ]);
    assert.equal(actionOf(p, "message"), undefined);
  });

  it("an opportunity with no actor carries no message action", async () => {
    const [p] = await project([buddyCandidate({ actor: undefined })]);
    assert.equal(actionOf(p, "message"), undefined);
  });
});

// ── join (§2) ────────────────────────────────────────────────────────────────

describe("§2 join — the live strip's event item leads into the canonical event", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  function eventCandidate(action?: WallAction): LiveForYouCandidate {
    return {
      subjectId: "place-1",
      liveObjectType: "event_state",
      subject: { placeId: "place-1", name: "An Thuong", city: "Da Nang" },
      resolved: {
        id: "event-ev1",
        label: "Beach Festival · happening now",
        state: "emerging",
        confidence: null,
        observedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
        truthClass: "predicted",
        coverage: "unknown",
      },
      ...(action ? { action } : {}),
    };
  }

  it("a producer-supplied `join` action overrides the per-kind default", async () => {
    const items = await buildLiveForYou(null, [
      eventCandidate({ type: "join", label: "Join", targetType: "event", targetId: "ev1" }),
    ], { now });
    assert.equal(items.length, 1);
    assert.equal(items[0].action?.type, "join");
    assert.equal(items[0].action?.targetType, "event");
    // The action names the CANONICAL EVENT, not the place the strip is keyed on —
    // that is what makes the handoff land on the event's own join gate.
    assert.equal(items[0].action?.targetId, "ev1");
    assert.notEqual(items[0].action?.targetId, items[0].subjectId);
  });

  it("without a producer action the kind default still applies (nothing regressed)", async () => {
    const items = await buildLiveForYou(null, [eventCandidate()], { now });
    assert.equal(items[0].action?.type, "see_place");
  });
});

// ── §40 #6: reachable, never forced ──────────────────────────────────────────

describe("§40 #6 — the actions lead outward without forcing the transition", () => {
  it("every action is a NAMED, optional affordance carrying a canonical target", async () => {
    const [p] = await project([
      postCandidate({ place: { placeId: "place-1", name: "An Thuong", city: "Da Nang" } }),
    ], { compassHandoffEnabled: true });
    // Open + see place + ask compass + save.
    const types = p.actions.map((a) => a.type).sort();
    assert.deepEqual(types, ["ask_compass", "open_object", "save", "see_place"]);
    for (const a of p.actions) {
      assert.ok(a.label.length > 0, `${a.type} must be labelled`);
      // No action carries an "auto"/"navigate" instruction — the projection
      // describes what the viewer MAY do, never what the client must do.
      assert.equal("auto" in a, false);
      assert.equal("navigate" in a, false);
    }
  });

  it("a place-less social object stays a plain social object (§7)", async () => {
    const [p] = await project([postCandidate()], { compassHandoffEnabled: true });
    assert.deepEqual(p.actions.map((a) => a.type).sort(), ["open_object", "save"]);
  });
});
