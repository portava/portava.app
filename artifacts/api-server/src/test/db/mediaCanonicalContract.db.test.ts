/**
 * mediaCanonicalContract — census-media §20: migration 3320's constraints and
 * version trigger, asserted BEHAVIOURALLY against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/mediaCanonicalContract.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * WHAT A TEXT TEST COULD NOT SHOW, AND THIS DOES
 *   MD41   the table itself refuses an entity_type outside the §6.1 nine — for
 *          any writer, not only the ones that go through lib/mediaAssets.
 *   MD43 / MD255
 *          visibility_override and media_assets.visibility hold only inherit +
 *          the §33 six (and NULL for the override); anything else is refused
 *          at INSERT rather than stored to be denied later.
 *   MD38   `version` moves on EVERY update, cannot be rewound by a writer, and
 *          a compare-and-set on a stale version matches ZERO rows — the lost
 *          update lib/mediaAssets.casUpdateMediaAsset exists to detect.
 *   MD44   one asset, one storage key, many product objects: the attachment
 *          rows fan out while the file's row stays single.
 *
 * ANTI-VACUITY: every refusal case is paired with an admission case on the
 * same table in the same test, so a missing table or a broken seed fails
 * instead of "refusing" everything.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

let U = "";
const ENTITY_TYPES = [
  "post", "postcard", "memory", "trip", "place", "event", "hidden_gem", "shared_moment", "observation",
] as const;
const AUDIENCES = ["inherit", "public", "followers", "following", "trip_crew", "shared_moment", "private"] as const;

/** Insert one media_assets row for U; returns its id. */
function seedAsset(over: { visibility?: string; path?: string } = {}): string {
  const id = randomUUID();
  const path = over.path ?? `${U}/${id}.jpg`;
  exec(`INSERT INTO public.media_assets
          (id, owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, visibility, width, height)
        VALUES ('${id}', '${U}', '${U}', 'post-media', '${path}', 'image', 'image/jpeg', '${over.visibility ?? "inherit"}', 800, 600);`);
  return id;
}

/** Run a statement that MUST fail; return psql's stderr. */
function refused(sql: string): string {
  const r = psql(sql);
  assert.notEqual(r.status, 0, `expected the database to refuse:\n${sql}`);
  return r.stderr;
}

describe("census-media §20 — migration 3320, executed", { skip: !HAVE_DB }, () => {
  before(() => {
    U = seedUser("md3320");
  });
  after(() => {
    if (!U) return;
    exec(`DELETE FROM public.media_assets WHERE owner_user_id = '${U}';`);
    deleteUser(U);
  });

  it("MD41 — every §6.1 entity type is admitted, and nothing else is", () => {
    const asset = seedAsset();
    for (const t of ENTITY_TYPES) {
      exec(`INSERT INTO public.media_attachments (media_asset_id, entity_type, entity_id)
            VALUES ('${asset}', '${t}', '${randomUUID()}');`);
    }
    assert.equal(
      scalar(`SELECT count(*) FROM public.media_attachments WHERE media_asset_id = '${asset}'`),
      String(ENTITY_TYPES.length),
      "all nine §6.1 entity types must be storable",
    );
    for (const bad of ["story", "profile", "Post", ""]) {
      const err = refused(`INSERT INTO public.media_attachments (media_asset_id, entity_type, entity_id)
                           VALUES ('${asset}', '${bad}', '${randomUUID()}');`);
      assert.match(err, /media_attachments_entity_type_check/, `entity_type '${bad}' must be refused by the CHECK`);
    }
  });

  it("MD43 / MD255 — visibility_override holds NULL, inherit or a §33 audience, and nothing else", () => {
    const asset = seedAsset();
    exec(`INSERT INTO public.media_attachments (media_asset_id, entity_type, entity_id, visibility_override)
          VALUES ('${asset}', 'post', '${randomUUID()}', NULL);`);
    for (const a of AUDIENCES) {
      exec(`INSERT INTO public.media_attachments (media_asset_id, entity_type, entity_id, visibility_override)
            VALUES ('${asset}', 'post', '${randomUUID()}', '${a}');`);
    }
    assert.equal(
      scalar(`SELECT count(*) FROM public.media_attachments WHERE media_asset_id = '${asset}'`),
      String(AUDIENCES.length + 1),
    );
    for (const bad of ["friends_only", "close_friends", "PUBLIC", "trip_only"]) {
      const err = refused(`INSERT INTO public.media_attachments (media_asset_id, entity_type, entity_id, visibility_override)
                           VALUES ('${asset}', 'post', '${randomUUID()}', '${bad}');`);
      assert.match(err, /media_attachments_visibility_override_check/, `override '${bad}' must be refused`);
    }
  });

  it("MD36 / MD255 — media_assets.visibility holds inherit or a §33 audience, and nothing else", () => {
    for (const a of AUDIENCES) seedAsset({ visibility: a });
    const err = refused(`INSERT INTO public.media_assets
      (owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, visibility, width, height)
      VALUES ('${U}', '${U}', 'post-media', '${U}/bad-vis.jpg', 'image', 'image/jpeg', 'friends', 800, 600);`);
    assert.match(err, /media_assets_visibility_check/);
    // The column default is still the §6 "defer to the parent" value.
    const id = randomUUID();
    exec(`INSERT INTO public.media_assets (id, owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, width, height)
          VALUES ('${id}', '${U}', '${U}', 'post-media', '${U}/default-vis.jpg', 'image', 'image/jpeg', 800, 600);`);
    assert.equal(scalar(`SELECT visibility FROM public.media_assets WHERE id = '${id}'`), "inherit");
  });

  it("MD38 — version moves on EVERY update, whoever issues it, and cannot be rewound", () => {
    const asset = seedAsset();
    assert.equal(scalar(`SELECT version FROM public.media_assets WHERE id = '${asset}'`), "1");
    // A writer that never reads the version (the processing lifecycle's shape).
    exec(`UPDATE public.media_assets SET processing_error = 'x' WHERE id = '${asset}';`);
    assert.equal(scalar(`SELECT version FROM public.media_assets WHERE id = '${asset}'`), "2");
    exec(`UPDATE public.media_assets SET processing_error = NULL WHERE id = '${asset}';`);
    assert.equal(scalar(`SELECT version FROM public.media_assets WHERE id = '${asset}'`), "3");
    // A writer that tries to REWIND it is overridden.
    exec(`UPDATE public.media_assets SET version = 1 WHERE id = '${asset}';`);
    assert.equal(scalar(`SELECT version FROM public.media_assets WHERE id = '${asset}'`), "4", "version must not be rewindable");
  });

  it("MD38 — a compare-and-set on a STALE version matches zero rows (the lost update is detected)", () => {
    const asset = seedAsset();
    // Two writers both read version 1 and both try to append an edit.
    const provA = `'{"sourceType":"camera","editHistory":[{"op":"crop","class":"evidence_preserving","at":"2026-09-26T00:00:00Z"}]}'::jsonb`;
    const provB = `'{"sourceType":"camera","editHistory":[{"op":"rotate","class":"evidence_preserving","at":"2026-09-26T00:00:01Z"}]}'::jsonb`;
    // A data-modifying statement cannot sit inside rows()' json_agg subquery,
    // so each compare-and-set is a top-level CTE returning its matched count.
    const a = scalar(
      `WITH u AS (UPDATE public.media_assets SET provenance = ${provA}, version = 2
        WHERE id = '${asset}' AND version = 1 RETURNING id) SELECT count(*) FROM u`,
    );
    assert.equal(a, "1", "the first writer's compare-and-set lands");
    assert.equal(scalar(`SELECT version FROM public.media_assets WHERE id = '${asset}'`), "2");
    const b = scalar(
      `WITH u AS (UPDATE public.media_assets SET provenance = ${provB}, version = 2
        WHERE id = '${asset}' AND version = 1 RETURNING id) SELECT count(*) FROM u`,
    );
    assert.equal(b, "0", "the second writer read a stale version and must match NOTHING");
    // …and the first writer's lineage survived.
    assert.equal(
      scalar(`SELECT provenance->'editHistory'->0->>'op' FROM public.media_assets WHERE id = '${asset}'`),
      "crop",
    );
  });

  it("MD44 — one asset, many product objects, one file row", () => {
    const asset = seedAsset({ path: `${U}/shared-file.jpg` });
    const post = randomUUID();
    const postcard = randomUUID();
    const memory = randomUUID();
    exec(`INSERT INTO public.media_attachments (media_asset_id, entity_type, entity_id, position, is_cover)
          VALUES ('${asset}', 'post', '${post}', 0, true),
                 ('${asset}', 'postcard', '${postcard}', 0, false),
                 ('${asset}', 'memory', '${memory}', 0, false);`);
    assert.equal(
      scalar(`SELECT count(*) FROM public.media_assets WHERE storage_path = '${U}/shared-file.jpg'`),
      "1",
      "the file has exactly one canonical row",
    );
    const linked = rows<{ entity_type: string }>(
      `SELECT entity_type FROM public.media_attachments WHERE media_asset_id = '${asset}' ORDER BY entity_type`,
    );
    assert.deepEqual(linked.map((r) => r.entity_type), ["memory", "post", "postcard"]);
    // The same (asset, entity) link cannot be written twice.
    const err = refused(`INSERT INTO public.media_attachments (media_asset_id, entity_type, entity_id)
                         VALUES ('${asset}', 'post', '${post}');`);
    assert.match(err, /duplicate key|unique/i);
    // And a second row for the same storage key is refused by the asset table.
    const dup = refused(`INSERT INTO public.media_assets
      (owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, width, height)
      VALUES ('${U}', '${U}', 'post-media', '${U}/shared-file.jpg', 'image', 'image/jpeg', 800, 600);`);
    assert.match(dup, /duplicate key|unique/i);
  });
});
