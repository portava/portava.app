/**
 * removeFromOwnCollections — an unsaved post leaves the collections it was filed in.
 *
 * Unsaving a post from Watch (DELETE /media/:id/save) or from the post
 * (DELETE /posts/:id/save) used to clear post_saves only, so the post stayed
 * listed in any collection it had been filed in from "Save to collection".
 *
 * Pinned: only the caller's collections are touched, only that entity; a
 * failed collections read is a failure, never "nothing to remove".
 *
 * Run:
 *   node --import tsx/esm --test src/test/collectionUnfile.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFakeClient } from "./telegraphCertificationHarness.js";
import { removeFromOwnCollections } from "../lib/collectionUnfile.js";

const ME = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const POST = "d0000000-0000-4000-8000-000000000004";
const POST2 = "d0000000-0000-4000-8000-000000000005";

function seed() {
  return {
    collections: [
      { id: "c-mine-1", owner_id: ME },
      { id: "c-mine-2", owner_id: ME },
      { id: "c-theirs", owner_id: OTHER },
    ],
    collection_items: [
      { id: "i1", collection_id: "c-mine-1", entity_type: "post", entity_id: POST },
      { id: "i2", collection_id: "c-mine-2", entity_type: "post", entity_id: POST },
      { id: "i3", collection_id: "c-mine-1", entity_type: "post", entity_id: POST2 },
      { id: "i4", collection_id: "c-theirs", entity_type: "post", entity_id: POST },
      { id: "i5", collection_id: "c-mine-1", entity_type: "event", entity_id: POST },
    ],
  };
}

describe("removeFromOwnCollections", () => {
  it("removes that post from every collection of mine, and nothing else", async () => {
    const sc = makeFakeClient(seed());
    const r = await removeFromOwnCollections(sc as any, ME, "post", POST);
    assert.equal(r.ok, true);
    const left = (sc._store.collection_items as Array<{ id: string }>).map((i) => i.id).sort();
    assert.deepEqual(left, ["i3", "i4", "i5"]);
  });

  it("someone with no collections has nothing removed, and that is a success", async () => {
    const sc = makeFakeClient({ ...seed(), collections: [{ id: "c-theirs", owner_id: OTHER }] });
    const r = await removeFromOwnCollections(sc as any, ME, "post", POST);
    assert.deepEqual(r, { ok: true, removedFrom: 0 });
    assert.equal(sc._store.collection_items.length, 5);
  });

  it("a failed collections read is a failure, and nothing is deleted", async () => {
    const sc = makeFakeClient(seed(), { errors: { collections: { message: "boom", code: "XX000" } as any } });
    const r = await removeFromOwnCollections(sc as any, ME, "post", POST);
    assert.equal(r.ok, false);
    assert.equal(sc._store.collection_items.length, 5);
  });

  it("a failed delete is a failure", async () => {
    const sc = makeFakeClient(seed(), { errors: { collection_items: { message: "denied", code: "42501" } as any } });
    const r = await removeFromOwnCollections(sc as any, ME, "post", POST);
    assert.equal(r.ok, false);
  });
});
