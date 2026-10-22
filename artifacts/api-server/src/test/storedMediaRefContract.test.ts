/**
 * A picked photo must not sink the save it is attached to.
 *
 * THE DEFECT
 * ==========
 * POST /media/upload (routes/posts.ts) answers `{ url: "post-media/<user>/<ts>.jpg" }` —
 * a bare storage ref, built as `${STORAGE_BUCKET}/${path}`. The client hands that
 * `url` straight back as the trip cover, the event cover, the Hidden Gem image and
 * the passport-memory photo. Every one of those fields was `z.string().url()`, which
 * zod refuses for a string with no scheme, so creating or editing any of them WITH a
 * photo answered 400 — the traveller lost the whole form, not just the picture.
 *
 * WHAT IS PINNED
 * ==============
 *   A. Every one of those schemas, exported from its route, accepts the exact shape
 *      the upload returns (image and video), and an https URL.
 *   B. None of them was widened to arbitrary strings: a bare word, a bucket outside
 *      the media allow-list, a `..` path, http on a foreign host, data: and
 *      javascript: are all still refused.
 *   C. The shared helper itself, including the app's own public storage URL on the
 *      configured origin.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/storedMediaRefContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ZodTypeAny } from "zod";

import { CreateTripSchema, PatchTripSchema } from "../routes/trips.js";
import { CreateEventSchema, UpdateEventSchema } from "../routes/events.js";
import { submitSchema } from "../routes/hiddenGems.js";
import { createMemorySchema, patchMemorySchema } from "../routes/passportStamps.js";
import { isStoredMediaRef, storedMediaRef } from "../lib/storedMediaRef.js";
import { configuredStorageOrigin } from "../lib/mediaUrl.js";

const USER = "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7";
// Exactly what routes/posts.ts returns as `url`: `${STORAGE_BUCKET}/${user.id}/${Date.now()}.${ext}`.
const UPLOADED_PHOTO = `post-media/${USER}/1761134400000.jpg`;
const UPLOADED_VIDEO = `post-media/${USER}/1761134400001.mp4`;

const REFUSED = [
  "not a url",
  "photo.jpg",
  "stamp-artwork/x/y.png",               // a bucket outside the media allow-list
  `post-media/../${USER}/secret.jpg`,    // traversal
  "post-media/",                          // no object
  "http://evil.example.com/a.jpg",       // http on a foreign host
  "data:image/jpeg;base64,/9j/4AAQ",
  "javascript:alert(1)",
  "//evil.example.com/post-media/x.jpg", // scheme-relative
];

/** Each schema, the field the photo travels in, and the rest of a body it accepts. */
const FIELDS: Array<{ name: string; schema: ZodTypeAny; field: string; base: Record<string, unknown> }> = [
  { name: "POST /trips (CreateTripSchema.coverUrl)", schema: CreateTripSchema, field: "coverUrl", base: { title: "Lisbon" } },
  { name: "PATCH /trips/:tripId (PatchTripSchema.coverUrl)", schema: PatchTripSchema, field: "coverUrl", base: {} },
  { name: "POST /events (CreateEventSchema.coverUrl)", schema: CreateEventSchema, field: "coverUrl", base: { title: "Sunset walk" } },
  { name: "PATCH /events/:id (UpdateEventSchema.coverUrl)", schema: UpdateEventSchema, field: "coverUrl", base: {} },
  { name: "POST /hidden-gems (submitSchema.imageUrl)", schema: submitSchema, field: "imageUrl", base: { name: "Quiet courtyard", category: "food", city: "Hoi An" } },
  { name: "POST memory (createMemorySchema.photoUrl)", schema: createMemorySchema, field: "photoUrl", base: { title: "First night" } },
  { name: "PATCH memory (patchMemorySchema.photoUrl)", schema: patchMemorySchema, field: "photoUrl", base: {} },
];

describe("A. every photo field accepts the ref POST /media/upload returns", () => {
  for (const f of FIELDS) {
    it(f.name, () => {
      // The base body alone parses: a failure below is the photo field's, not the fixture's.
      const bare = f.schema.safeParse(f.base);
      assert.equal(bare.success, true, JSON.stringify(bare.success ? null : bare.error.issues));
      for (const ref of [UPLOADED_PHOTO, UPLOADED_VIDEO, "https://images.example.com/cover.jpg"]) {
        const r = f.schema.safeParse({ ...f.base, [f.field]: ref });
        assert.equal(r.success, true, `${f.field}=${ref} → ${JSON.stringify(r.success ? null : r.error.issues)}`);
        assert.equal((r as any).data[f.field], ref, "the ref is stored as sent, not rewritten");
      }
      // Clearing the photo still works where it did.
      assert.equal(f.schema.safeParse({ ...f.base, [f.field]: null }).success, true);
    });
  }
});

describe("B. none of them was widened to arbitrary strings", () => {
  for (const f of FIELDS) {
    it(f.name, () => {
      for (const v of REFUSED) {
        assert.equal(f.schema.safeParse({ ...f.base, [f.field]: v }).success, false, `${f.field} must refuse ${v}`);
      }
    });
  }
});

describe("C. the shared helper", () => {
  it("accepts our own public storage URL on the configured origin, refuses the same path on another host", (t) => {
    // The package test line configures a storage origin; without one the absolute form has nothing to match.
    const origin = configuredStorageOrigin();
    if (!origin) { t.skip("no storage origin configured for this run"); return; }
    assert.equal(isStoredMediaRef(`${origin}/storage/v1/object/public/post-media/${USER}/a.jpg`), true);
    assert.equal(isStoredMediaRef(`http://foreign.example.test/storage/v1/object/public/post-media/${USER}/a.jpg`), false);
  });

  it("refuses an over-long ref and the empty string", () => {
    assert.equal(storedMediaRef.safeParse("").success, false);
    assert.equal(storedMediaRef.safeParse(`https://x.example.com/${"a".repeat(2100)}`).success, false);
  });
});
