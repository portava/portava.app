import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterMediaByCurrentPlace, MediaPlaceGovernanceUnavailable } from "../lib/media/mediaPlaceGovernance.js";
import { filterEligibleMediaCandidates } from "../lib/mediaEligibility.js";
import { projectCandidatesProtected, buildPlaceProjection, readCurrentState } from "../services/media/MediaProjectionService.js";
import { shareableFor } from "../services/telegraph/shareables.js";
import { makeFakeMapDb } from "./helpers/fakeMapDb.js";

const PLACE = "aaaaaaaa-0000-4000-8000-000000000001";
const PARENT = "aaaaaaaa-0000-4000-8000-000000000002";
const VIEWER = "bbbbbbbb-0000-4000-8000-000000000001";
const viewer = { viewerId: VIEWER, viewerCountry: null, viewerAge: null, followedCreatorIds: new Set<string>(), viewerTripIds: new Set<string>() };
const row = (id: string, place: string | null) => ({ id, canonical_place_id: place, author_id: VIEWER, created_at: new Date().toISOString() });
function fixture() {
  const state: Record<string, any> = { places: [{ id: PLACE, name: "Withdrawable venue", status: "active", moderation_status: "visible", merged_into_place_id: null }] };
  const sc = makeFakeMapDb(state, { token: "test", userId: VIEWER });
  return { state, sc };
}

describe("Media and Telegraph current canonical place moderation", () => {
  it("public media keeps visible and place-free rows, suppresses missing/withheld places", async () => {
    const { sc, state } = fixture();
    const rows = [row("visible", PLACE), row("missing", PARENT), row("free", null)];
    assert.deepEqual((await filterMediaByCurrentPlace(sc, rows)).map(r => r.id), ["visible", "free"]);
    state.places[0].moderation_status = "withheld";
    assert.deepEqual((await filterMediaByCurrentPlace(sc, rows)).map(r => r.id), ["free"]);
  });
  it("a withheld ancestor suppresses a visible merge alias", async () => {
    const { sc, state } = fixture();
    state.places[0].merged_into_place_id = PARENT;
    state.places.push({ id: PARENT, moderation_status: "withheld", merged_into_place_id: null });
    assert.deepEqual(await filterMediaByCurrentPlace(sc, [row("alias", PLACE)]), []);
  });
  it("unreadable and pre-migration catalog policy are retryable failures", async () => {
    const { sc, state } = fixture();
    state.places[0].moderation_status = undefined;
    await assert.rejects(() => filterMediaByCurrentPlace(sc, [row("old-schema", PLACE)]), MediaPlaceGovernanceUnavailable);
    state.places = { error: { message: "unreadable" } };
    await assert.rejects(() => filterMediaByCurrentPlace(sc, [row("failed", PLACE)]), { status: 503, code: "degraded_unavailable" });
  });
  it("Watch/Grid eligibility and already-loaded projection rows both honor withdrawal", async () => {
    const { sc, state } = fixture(); state.places[0].moderation_status = "withheld";
    const rows = [row("cached", PLACE)];
    const gate = await filterEligibleMediaCandidates(rows, { viewerUserId: VIEWER, feedType: "for_you", followedCreatorIds: new Set() }, sc);
    assert.deepEqual(gate.eligible, []);
    assert.deepEqual(await projectCandidatesProtected(sc, viewer, rows, Date.now()), []);
  });
  it("direct place media and live enrichment do not disclose a withdrawn subject", async () => {
    const { sc, state } = fixture(); state.places[0].moderation_status = "withheld";
    await assert.rejects(() => buildPlaceProjection(sc, viewer, PLACE, Date.now()), { status: 404, code: "not_found" });
    assert.deepEqual(await readCurrentState(sc, PLACE, Date.now()), { live: false, claims: [], crowdLabel: null });
  });
  for (const type of ["PLACE", "MAP_PIN", "MEETUP_POINT"] as const) {
    it(`${type} rechecks a previously loaded card and withholds title, actions and state`, async () => {
      const { sc, state } = fixture();
      const card = shareableFor(sc, type, PLACE)!;
      assert.equal((await card.getSharePreview(VIEWER))?.title, "Withdrawable venue");
      state.places[0].moderation_status = "withheld";
      assert.equal(await card.getSharePreview(VIEWER), null);
      assert.equal((await card.getCurrentState(VIEWER)).available, false);
      assert.deepEqual(await card.getAvailableActions(VIEWER, "thread"), []);
    });
  }
  it("a cached Telegraph place never survives a policy outage", async () => {
    const { sc, state } = fixture(); const card = shareableFor(sc, "PLACE", PLACE)!;
    assert.equal((await card.getCurrentState(VIEWER)).available, true);
    state.places = { error: { message: "connection lost" } };
    assert.equal(await card.getSharePreview(VIEWER), null);
    assert.equal((await card.getCurrentState(VIEWER)).reason, "unknown");
  });
});
