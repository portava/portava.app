import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredMediaJobHandler } from "../lib/media/jobs/registry.js";
import { MediaJobError } from "../lib/media/jobs/queue.js";
import { makeFeedDb } from "./helpers/fakeFeedDb.js";

test("all optional worker kinds remain inert when unconfigured", async () => {
  const fake = makeFeedDb({ users: {}, tables: {} });
  for (const kind of ["adaptive_video", "vision", "embedding", "captions", "image_variants", "dubbing", "subtitle_translation", "unknown"]) {
    assert.equal(await configuredMediaJobHandler(fake.client, { MEDIA_WORKER_KIND: kind }), null, kind);
  }
  assert.deepEqual(fake.tables, {});
});

test("caption worker cannot start with an enabled flag and missing pinned runtime", async () => {
  const fake = makeFeedDb({ users: {}, tables: {} });
  await assert.rejects(configuredMediaJobHandler(fake.client, { MEDIA_WORKER_KIND: "captions", MEDIA_CAPTION_ASR_ENABLED: "true" }),
    error => error instanceof MediaJobError && error.code === "invalid_caption_configuration" && error.retryable === false);
});

test("image worker configuration does not perform encoding or query storage on construction", async () => {
  const fake = makeFeedDb({ users: {}, tables: {} });
  const handler = await configuredMediaJobHandler(fake.client, {
    MEDIA_WORKER_KIND: "image_variants", MEDIA_IMAGE_VARIANTS_ENABLED: "1", MEDIA_IMAGE_VARIANTS_ROOT: "/unconfigured/private-volume",
    SUPABASE_URL: "https://synthetic-project.supabase.co",
  });
  assert.equal(handler?.kind, "image_variants");
  assert.equal(handler?.modelVersion, "sharp-responsive-v1");
  assert.deepEqual(fake.tables, {});
});
