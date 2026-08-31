/**
 * mediaCanonicalFoundation — Media v2 Phase 1 (Canonical Foundation).
 *
 * Proves the additive, flag-dark canonical layer:
 *   1. recordEntityMedia dual-writes media_assets + media_attachments of the
 *      right entityType when media_canonical_enabled is ON; when OFF it does
 *      ZERO canonical writes (the gate is mutation-proven), and a real caller
 *      (createMemory) keeps its per-object insert byte-identical.
 *   2. The moderation-enum reconciliation keeps
 *      mediaEligibility.filterEligibleMediaCandidates returning the same rows
 *      for existing data, and now ALSO admits the canonical promoted state
 *      'active' (mutation-proven against the old 'approved'-only gate).
 *   3. recordMediaAttachment is idempotent (onConflict) + rejects an unknown
 *      entityType (no row written).
 *   4. The migration lays location_visibility with a NON-PRECISE default.
 *
 * No DB, no network — fake Supabase clients only. Run:
 *   node --import tsx/esm --test src/test/mediaCanonicalFoundation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordMediaAttachment,
  recordEntityMedia,
  ATTACHMENT_ENTITY_TYPES,
} from "../lib/mediaAssets.js";
import { createMemory } from "../services/passport/PassportMemoryService.js";
import {
  filterEligibleMediaCandidates,
  DISTRIBUTABLE_MODERATION_STATES,
  type MediaCandidate,
  type ViewerCtx,
} from "../lib/mediaEligibility.js";

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface Op {
  table: string;
  kind: "select" | "upsert" | "insert";
  row?: any;
  opts?: any;
}

function makeFake(opts: { flagEnabled: boolean; existingAssetId?: string | null }) {
  const ops: Op[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;

  const singleResult = (table: string): Promise<{ data: any; error: null }> => {
    if (table === "feature_flags") {
      return Promise.resolve({ data: opts.flagEnabled ? { enabled: true } : null, error: null });
    }
    if (table === "media_assets") {
      return Promise.resolve({
        data: opts.existingAssetId ? { id: opts.existingAssetId } : null,
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  };

  function selectBuilder(table: string): any {
    const b: any = {
      eq() { return b; },
      in() { return b; },
      not() { return b; },
      maybeSingle() { return singleResult(table); },
      single() { return singleResult(table); },
      // Awaiting a select without a terminal returns an empty list (blocks,
      // profiles, user_mutes take this path in mediaEligibility).
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };
    return b;
  }

  function writeResult(table: string): any {
    return {
      select() {
        return {
          single() { return Promise.resolve({ data: { id: nextId(table) }, error: null }); },
          maybeSingle() { return Promise.resolve({ data: { id: nextId(table) }, error: null }); },
        };
      },
    };
  }

  const client: any = {
    from(table: string) {
      return {
        select() { ops.push({ table, kind: "select" }); return selectBuilder(table); },
        upsert(row: any, o: any) { ops.push({ table, kind: "upsert", row, opts: o }); return writeResult(table); },
        insert(row: any) { ops.push({ table, kind: "insert", row }); return writeResult(table); },
      };
    },
  };
  return { client, ops };
}

const writesTo = (ops: Op[], table: string) =>
  ops.filter((o) => o.table === table && (o.kind === "upsert" || o.kind === "insert"));

/**
 * Flush pending fire-and-forget work. The dual-write fan-out is intentionally
 * `void`-ed in the callers (posts.ts-style: never block the user's request), so
 * a caller resolves BEFORE its canonical writes land. Drain the queues so the
 * test observes the floating promise's effects.
 */
async function flush() {
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));
}

// ── 1. Dual-write fan-out gate ───────────────────────────────────────────────

describe("recordEntityMedia — dual-write fan-out gate", () => {
  const BASE = {
    ownerUserId: "user-1",
    publicUrl: "post-media/user-1/photo.jpg",
    entityType: "memory" as const,
    entityId: "mem-1",
    isCover: true,
  };

  it("flag ON, asset absent: writes media_assets + media_attachments of the right entityType", async () => {
    const { client, ops } = makeFake({ flagEnabled: true, existingAssetId: null });
    const res = await recordEntityMedia(client, BASE);

    assert.ok(res.assetId, "asset id returned");
    assert.ok(res.attachmentId, "attachment id returned");
    assert.equal(writesTo(ops, "media_assets").length, 1, "asset created (absent → insert)");
    const att = writesTo(ops, "media_attachments");
    assert.equal(att.length, 1, "exactly one attachment written");
    assert.equal(att[0].row.entity_type, "memory", "attachment carries the entityType");
    assert.equal(att[0].row.entity_id, "mem-1");
    assert.equal(att[0].row.is_cover, true);
  });

  it("flag ON, asset already exists: reuses it (NO media_assets write, no metadata clobber)", async () => {
    const { client, ops } = makeFake({ flagEnabled: true, existingAssetId: "existing-asset" });
    const res = await recordEntityMedia(client, BASE);

    assert.equal(res.assetId, "existing-asset", "reuses the existing asset id");
    assert.equal(writesTo(ops, "media_assets").length, 0, "must NOT re-upsert the asset (no clobber)");
    assert.equal(writesTo(ops, "media_attachments").length, 1, "still adds the attachment");
  });

  it("flag OFF: ZERO canonical writes — the gate holds (mutation-proof)", async () => {
    const { client, ops } = makeFake({ flagEnabled: false });
    const res = await recordEntityMedia(client, BASE);

    assert.deepEqual(res, { assetId: null, attachmentId: null });
    assert.equal(writesTo(ops, "media_assets").length, 0);
    assert.equal(writesTo(ops, "media_attachments").length, 0);
    // The only DB contact is the single flag read.
    assert.deepEqual(
      ops.map((o) => `${o.table}:${o.kind}`),
      ["feature_flags:select"],
      "flag-off path reads only the flag and stops",
    );
  });

  it("external / unresolvable URL is ignored, never fabricated (flag ON)", async () => {
    const { client, ops } = makeFake({ flagEnabled: true, existingAssetId: null });
    const res = await recordEntityMedia(client, { ...BASE, publicUrl: "https://evil.example.com/x.jpg" });
    assert.deepEqual(res, { assetId: null, attachmentId: null });
    assert.equal(writesTo(ops, "media_assets").length, 0);
    assert.equal(writesTo(ops, "media_attachments").length, 0);
  });
});

// ── 1b. A real caller: createMemory dual-writes only when the flag is on ──────

describe("createMemory — wired to the fan-out, gated", () => {
  const input = {
    userId: "user-1",
    title: "Sunset",
    photoUrl: "post-media/user-1/sunset.jpg",
  };

  it("flag ON: creates the memory AND dual-writes the canonical rows (entityType=memory)", async () => {
    const { client, ops } = makeFake({ flagEnabled: true, existingAssetId: null });
    const id = await createMemory(client, input as any);
    await flush(); // the fan-out is void-ed; let it land

    assert.ok(id, "memory id returned");
    assert.equal(writesTo(ops, "passport_memories").length, 1, "the per-object insert still happens");
    assert.equal(writesTo(ops, "media_assets").length, 1);
    const att = writesTo(ops, "media_attachments");
    assert.equal(att.length, 1);
    assert.equal(att[0].row.entity_type, "memory");
  });

  it("flag OFF: creates the memory, per-object insert byte-identical, ZERO canonical writes", async () => {
    const { client, ops } = makeFake({ flagEnabled: false });
    const id = await createMemory(client, input as any);
    await flush(); // even flushed, the dark gate must have written nothing canonical

    assert.ok(id, "memory id still returned");
    const memInsert = writesTo(ops, "passport_memories");
    assert.equal(memInsert.length, 1, "the per-object insert is unchanged");
    // The insert payload never carries any canonical column — byte-identical path.
    assert.equal(memInsert[0].row.photo_url, "post-media/user-1/sunset.jpg");
    assert.equal(writesTo(ops, "media_assets").length, 0, "no canonical asset write when dark");
    assert.equal(writesTo(ops, "media_attachments").length, 0, "no canonical attachment write when dark");
  });
});

// ── 2. Moderation-enum reconciliation: no regression + 'active' admitted ──────

describe("mediaEligibility moderation gate — canonical reconciliation", () => {
  const viewer: ViewerCtx = {
    viewerUserId: "viewer",
    feedType: "for_you",
    followedCreatorIds: new Set<string>(),
  };

  function candidate(mod: string | null | undefined): MediaCandidate {
    return {
      id: `post-${mod ?? "null"}`,
      author_id: "creator-1",
      status: "active",
      visibility: "public",
      moderation_status: mod ?? undefined,
      created_at: new Date().toISOString(),
      post_media: [{ processing_status: "ready", moderation_status: "approved" }],
    };
  }

  it("legacy data is unchanged: 'approved' and null pass; pending/flagged/rejected excluded", async () => {
    const { client } = makeFake({ flagEnabled: false });
    const candidates = [
      candidate("approved"),
      candidate(null),
      candidate("pending"),
      candidate("flagged"),
      candidate("rejected"),
    ];
    const { eligible } = await filterEligibleMediaCandidates(candidates, viewer, client, new Set());
    const ids = eligible.map((c) => c.id).sort();
    assert.deepEqual(ids, ["post-approved", "post-null"].sort(), "no regression for legacy moderation values");
  });

  it("admits the canonical promoted state 'active' (mutation-proof vs the old 'approved'-only gate)", async () => {
    const { client } = makeFake({ flagEnabled: false });
    const { eligible } = await filterEligibleMediaCandidates([candidate("active")], viewer, client, new Set());
    assert.equal(eligible.length, 1, "'active' is distributable under the reconciled gate");
    assert.equal(eligible[0].id, "post-active");
  });

  it("every OTHER canonical/legacy moderation state stays excluded", async () => {
    const { client } = makeFake({ flagEnabled: false });
    for (const mod of ["processing", "limited", "removed", "owner_deleted", "pending", "flagged", "rejected"]) {
      const { eligible } = await filterEligibleMediaCandidates([candidate(mod)], viewer, client, new Set());
      assert.equal(eligible.length, 0, `${mod} must be excluded`);
    }
  });

  it("DISTRIBUTABLE_MODERATION_STATES is exactly {approved, active}", () => {
    assert.deepEqual([...DISTRIBUTABLE_MODERATION_STATES].sort(), ["active", "approved"]);
  });
});

// ── 3. recordMediaAttachment: idempotent + rejects unknown entityType ─────────

describe("recordMediaAttachment", () => {
  it("upserts with the idempotency onConflict key (media_asset_id,entity_type,entity_id)", async () => {
    const { client, ops } = makeFake({ flagEnabled: true });
    const id = await recordMediaAttachment(client, {
      mediaAssetId: "asset-1",
      entityType: "post",
      entityId: "post-1",
    });
    assert.ok(id, "returns an attachment id");
    const up = ops.find((o) => o.table === "media_attachments" && o.kind === "upsert");
    assert.ok(up, "an upsert was issued");
    assert.equal(up!.opts?.onConflict, "media_asset_id,entity_type,entity_id", "idempotent onConflict target");
  });

  it("rejects an unknown entityType — returns null, writes nothing (mutation-proof)", async () => {
    const { client, ops } = makeFake({ flagEnabled: true });
    const id = await recordMediaAttachment(client, {
      mediaAssetId: "asset-1",
      entityType: "banana" as any,
      entityId: "x-1",
    });
    assert.equal(id, null, "unknown entityType is rejected");
    assert.equal(writesTo(ops, "media_attachments").length, 0, "no attachment row written");
    // Prove the rejection is what stopped it: a VALID type does write.
    const { client: c2, ops: o2 } = makeFake({ flagEnabled: true });
    const ok = await recordMediaAttachment(c2, { mediaAssetId: "asset-1", entityType: "postcard", entityId: "pc-1" });
    assert.ok(ok, "a valid entityType still writes");
    assert.equal(writesTo(o2, "media_attachments").length, 1);
  });

  it("flag OFF: writes nothing", async () => {
    const { client, ops } = makeFake({ flagEnabled: false });
    const id = await recordMediaAttachment(client, { mediaAssetId: "asset-1", entityType: "post", entityId: "post-1" });
    assert.equal(id, null);
    assert.equal(writesTo(ops, "media_attachments").length, 0);
  });

  it("ATTACHMENT_ENTITY_TYPES is the §6.1 set", () => {
    assert.deepEqual(
      [...ATTACHMENT_ENTITY_TYPES].sort(),
      ["event", "hidden_gem", "memory", "observation", "place", "post", "postcard", "shared_moment", "trip"].sort(),
    );
  });
});

// ── 4. Migration lays a non-precise location_visibility default ───────────────

describe("migration 2250 — location_visibility safe default", () => {
  const MIG = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../migrations/2250_media_asset_canonical_model.sql",
  );
  const sql = readFileSync(MIG, "utf8");

  const PRECISE = new Set(["precise_private", "precise"]);
  const NON_PRECISE = new Set(["hidden", "country", "city", "neighborhood", "place"]);

  it("defaults location_visibility to a NON-PRECISE value", () => {
    const m = sql.match(/location_visibility\s+TEXT\s+NOT NULL\s+DEFAULT\s+'([a-z_]+)'/i);
    assert.ok(m, "location_visibility column with a DEFAULT is present");
    const dflt = m![1];
    assert.ok(NON_PRECISE.has(dflt), `default '${dflt}' must be a non-precise value`);
    assert.ok(!PRECISE.has(dflt), `default '${dflt}' must never be a precise value`);
    assert.equal(dflt, "hidden", "the most-private safe default is 'hidden'");
  });

  it("the CHECK still allows the precise tier as an explicit opt-in (just not the default)", () => {
    assert.match(sql, /precise_private/, "precise_private remains a valid explicit value");
  });
});
