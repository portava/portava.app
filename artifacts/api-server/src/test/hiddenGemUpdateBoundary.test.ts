/**
 * The application half of the hidden-gem self-publish boundary.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `hidden_gems.status` (publication), `verification_level`, `moderation_status`
 * and `guide_verified_by` are set by verification/moderation. The public
 * Discovery feed and Compass read gems where status = 'active', so a self-set
 * status injects unmoderated, self-"verified" content into Discovery.
 *
 * There are two independent defences and they are NOT interchangeable:
 *
 *   1. Migration 2147 grants authenticated column-UPDATE on the ten owner-edit
 *      content fields and revokes the rest. That is asserted by
 *      src/test/hiddenGemSelfPublish.test.ts — a LIVE-DB suite that refuses to
 *      run without CI credentials. Measured in this environment: it exits 1 with
 *      the ciSupabaseGuard refusal, i.e. it is honestly unavailable rather than
 *      vacuously green, and it is NOT a witness here.
 *   2. `buildPatch` in HiddenGemService, which every update goes through.
 *
 * Defence 1 does not cover the path that matters most: routes/hiddenGems.ts
 * reaches hidden_gems through the SERVICE client, which BYPASSES RLS. On that
 * path the allowlist is the only thing between a caller's JSON body and
 * `status`. That is the half this file tests, and it runs everywhere.
 *
 * The double records the payload handed to `.update()`, so what is asserted is
 * the columns actually written, not the shape of the input.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/hiddenGemUpdateBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { updateGem, updateGemAsGuide } from "../services/hiddenGems/HiddenGemService.js";

const GEM   = "a0000000-0000-4000-a000-000000000001";
const OWNER = "a0000000-0000-4000-a000-000000000002";
const GUIDE = "a0000000-0000-4000-a000-000000000003";

/** Columns only verification / moderation may ever set. */
const PRIVILEGED = [
  "status",
  "verification_level",
  "moderation_status",
  "guide_verified_by",
  "save_count",
  "visit_count",
  "report_count",
  "submitted_by",
] as const;

function seed() {
  return {
    hidden_gems: [{ id: GEM, submitted_by: OWNER, status: "active", verification_level: "unverified" }],
    local_guide_profiles: [{ user_id: GUIDE, status: "active", city_expertise: ["Manila"] }],
  };
}

/** Everything a caller might try to smuggle in, in one body. */
const HOSTILE_PATCH = {
  name: "Renamed",
  status: "active",
  verification_level: "guide_verified",
  moderation_status: "approved",
  guide_verified_by: OWNER,
  save_count: 9999,
  visit_count: 9999,
  report_count: 0,
  submitted_by: GUIDE,
} as any;

describe("updateGem — the owner-edit allowlist is what reaches the UPDATE", () => {
  it("CONTROL: an allowed content field IS written", async () => {
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({ rows: seed(), updated });

    await updateGem(db, GEM, OWNER, { name: "Renamed" } as any);

    const writes = updated["hidden_gems"] ?? [];
    assert.equal(writes.length, 1, "vacuity guard: the update must actually happen");
    assert.equal(writes[0].name, "Renamed", "…and must carry the field the owner may edit");
  });

  for (const col of PRIVILEGED) {
    it(`a caller-supplied "${col}" never reaches the UPDATE`, async () => {
      const updated: Record<string, any[]> = {};
      const db = makeFailClosedClient({ rows: seed(), updated });

      await updateGem(db, GEM, OWNER, HOSTILE_PATCH);

      const writes = updated["hidden_gems"] ?? [];
      assert.equal(writes.length, 1, "vacuity guard: the update ran, so the payload is real");
      assert.ok(
        !(col in writes[0]),
        `"${col}" was written: ${JSON.stringify(writes[0])} — the service client bypasses RLS, so nothing else stops it`,
      );
      // And the legitimate field in the same body still landed, so this is a
      // FILTER and not a wholesale refusal.
      assert.equal(writes[0].name, "Renamed");
    });
  }
});

describe("updateGemAsGuide — a guide edits four fields and nothing else", () => {
  it("CONTROL: an active guide's allowed field IS written", async () => {
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({ rows: seed(), updated });

    await updateGemAsGuide(db, GEM, GUIDE, { safetyNotes: "Slippery after rain" } as any);

    const writes = updated["hidden_gems"] ?? [];
    assert.equal(writes.length, 1, "vacuity guard: the guide edit must actually happen");
    assert.equal(writes[0].safety_notes, "Slippery after rain");
  });

  it("a guide cannot set status, verification_level or the gem's name", async () => {
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({ rows: seed(), updated });

    await updateGemAsGuide(db, GEM, GUIDE, {
      safetyNotes: "Slippery after rain",
      name: "Renamed by a guide",
      status: "active",
      verification_level: "guide_verified",
    } as any);

    const writes = updated["hidden_gems"] ?? [];
    assert.equal(writes.length, 1);
    assert.equal(writes[0].safety_notes, "Slippery after rain", "the guide-safe field still lands");
    for (const col of ["status", "verification_level", "name"]) {
      assert.ok(!(col in writes[0]), `a guide wrote "${col}": ${JSON.stringify(writes[0])}`);
    }
  });

  it("a non-guide is refused before any write", async () => {
    const updated: Record<string, any[]> = {};
    const rows = seed();
    rows.local_guide_profiles = [];
    const db = makeFailClosedClient({ rows, updated });

    await assert.rejects(() => updateGemAsGuide(db, GEM, GUIDE, { safetyNotes: "x" } as any));
    assert.equal((updated["hidden_gems"] ?? []).length, 0, "no write may have been attempted");
  });

  it("an UNREADABLE local_guide_profiles refuses too — not 'no row, therefore fine'", async () => {
    // The guide row IS present; only the read fails. A guard that read a
    // resolved error as an absent row would still refuse here, but a guard that
    // fell through on error would write — and nothing else in the fixture could
    // produce that write.
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: seed(),
      failOn: (ctx: FakeReadContext) =>
        ctx.table === "local_guide_profiles" ? { code: "57P01", message: "guides unreadable" } : null,
      updated,
    });

    await assert.rejects(() => updateGemAsGuide(db, GEM, GUIDE, { safetyNotes: "x" } as any));
    assert.equal((updated["hidden_gems"] ?? []).length, 0, "an unverifiable guide claim writes nothing");
  });
});
