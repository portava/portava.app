/**
 * My World's Tagged bucket (§30) — proven against the LIVE `tags` schema.
 *
 * THE DEFECT THIS PINS. `loadTaggedPostIds` selected and ordered by
 * `tags.tagged_at`. That column does not exist. The CANONICAL migration
 * `0043_tags_hashtags.sql` declares it, but it was never applied:
 * `migrations/README.md:12` — "a column that was never applied and does not
 * exist live" — and `docs/migrations.md:26` records it in the audit allowlist
 * for exactly that reason. Live `tags` carries `created_at`.
 *
 * PostgREST rejects an unknown column with 42703 and fails the WHOLE
 * statement, and supabase-js RESOLVES that rejection rather than throwing, so
 * the read landed in `loadTaggedPostIds`'s own `if (error)` branch and returned
 * `[]` with a warn line. The Tagged bucket was therefore EMPTY FOR EVERY
 * VIEWER, always — not "empty because you have no tags", empty because the
 * query could never run. Nothing above it could tell the difference: an empty
 * bucket is the documented degradation.
 *
 * WHY THE EXISTING TESTS DID NOT CATCH IT. `mediaProjectionGaps.test.ts`
 * covers this function four times and all four pass, because its fixture rows
 * carry a `tagged_at` key. The fixture was written to match the code, so the
 * tests proved the code matched the fixture and proved nothing about the
 * database. These tests drive the PRODUCTION function through
 * `makeSchemaStrictClient`, which checks every column named in a select list or
 * a filter against `generated/liveColumns.json` (the live information_schema)
 * and answers 42703 exactly as production does.
 *
 * WHAT TURNS THIS RED. Point the read back at `tagged_at` — in the select list
 * or in the `.order()` — and the first test fails with the dead column named.
 *
 * Runtime: node:test, no HTTP, no DB, no network.
 * Run: node --import tsx/esm --test src/test/mediaTaggedBucketLiveSchema.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSchemaStrictClient } from "./helpers/schemaStrictSupabase.js";
import { loadTaggedPostIds } from "../services/media/MediaProjectionService.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TAGGER = "33333333-3333-4333-8333-333333333333";
const POST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POST_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function tagRow(over: Record<string, unknown> = {}) {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    source_type: "post",
    source_id: POST_A,
    tagger_id: TAGGER,
    tagged_user_id: VIEWER,
    status: "approved",
    suppressed: false,
    suppressed_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

describe("§30 Tagged bucket — every column it names is a column the live tags table has", () => {
  it("returns the viewer's approved post tags instead of degrading to empty", async () => {
    const sc = makeSchemaStrictClient({ tags: [tagRow()] });
    const ids = await loadTaggedPostIds(sc as any, VIEWER);
    assert.deepEqual(
      sc.deadColumnErrors,
      [],
      "the Tagged read named a column live `tags` does not have, so PostgREST failed the whole " +
        "statement and the bucket degraded to empty for every viewer",
    );
    assert.deepEqual(ids, [POST_A], "the tagged post must come back, not an empty bucket");
  });

  it("orders newest-first by a real column, so a second page is a real page", async () => {
    const sc = makeSchemaStrictClient({
      tags: [
        tagRow({ id: "11111111-0000-4000-8000-000000000001", source_id: POST_A, created_at: "2026-01-01T00:00:00.000Z" }),
        tagRow({ id: "11111111-0000-4000-8000-000000000002", source_id: POST_B, created_at: "2026-09-01T00:00:00.000Z" }),
      ],
    });
    const ids = await loadTaggedPostIds(sc as any, VIEWER, 1);
    assert.deepEqual(sc.deadColumnErrors, [], "no dead column in the ordered read");
    assert.deepEqual(
      ids,
      [POST_B],
      "with limit 1 the NEWEST tag must survive — an order key the database rejects would " +
        "either fail the read or return an arbitrary row",
    );
  });

  it("still ignores a pending tag, someone else's tag, and a comment tag", async () => {
    const sc = makeSchemaStrictClient({
      tags: [
        tagRow({ id: "22222222-0000-4000-8000-000000000001", source_id: POST_B, status: "pending" }),
        tagRow({ id: "22222222-0000-4000-8000-000000000002", source_id: POST_B, tagged_user_id: OTHER }),
        tagRow({ id: "22222222-0000-4000-8000-000000000003", source_id: POST_B, source_type: "comment" }),
        tagRow(),
      ],
    });
    const ids = await loadTaggedPostIds(sc as any, VIEWER);
    assert.deepEqual(sc.deadColumnErrors, [], "no dead column in the filtered read");
    assert.deepEqual(
      ids,
      [POST_A],
      "the three gates survive the column repair — this is the guard against 'fixed the column, " +
        "dropped a filter'",
    );
  });
});
