/**
 * mediaModerationCanonical — census-media §20 (Lane B): §36 MediaModerationStatus
 * as a live state machine on the canonical asset (MD274), owned by a
 * MediaModerationService (MD351), and the two readers that had to speak §36
 * before the vocabulary could go live.
 *
 * The DB half — 3321's default and its normalising trigger — is asserted in
 * src/test/db/mediaCanonicalContract.db.test.ts against PostgreSQL.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import {
  applyCanonicalModerationDecision,
  canTransition,
  isDistributableModerationState,
  stateForDecision,
  MEDIA_MODERATION_STATUSES,
} from "../services/media/MediaModerationService.js";
import { resetCanonicalSchemaMemo } from "../lib/media/mediaSchemaCapability.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminMediaRouter from "../routes/adminMedia.js";
import { loadQuickMediaItems } from "../services/wall/WallCandidateLoaders.js";
import { shareableFor } from "../services/telegraph/shareables.js";

type Row = Record<string, any>;

/** A small in-memory table store with the PostgREST chain the code under test uses. */
function makeStore(tables: Record<string, Row[]>, opts: { schemaMissing?: boolean; failFirstCasOn?: string } = {}) {
  let casFailures = opts.failFirstCasOn ? 1 : 0;
  function chain(name: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    let update: Row | null = null;
    let insert: Row | null = null;
    let selectCols = "";
    let single = false;
    const rows = () => (tables[name] ??= []);
    const match = (r: Row) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]));
    async function resolve(): Promise<{ data: any; error: any }> {
      if (name === "media_assets" && opts.schemaMissing && /location_visibility/.test(selectCols) && update === null) {
        return { data: null, error: { code: "42703", message: "column media_assets.captured_at does not exist" } };
      }
      if (insert) {
        const r = { id: `new-${rows().length + 1}`, ...insert };
        rows().push(r);
        return { data: single ? r : [r], error: null };
      }
      if (update) {
        // A concurrent writer wins the FIRST compare-and-set on this table:
        // it bumps the row's version just before our update runs.
        if (name === opts.failFirstCasOn && casFailures > 0) {
          casFailures--;
          for (const r of rows()) r.version = (r.version ?? 1) + 1;
        }
        const hit = rows().filter(match);
        for (const r of hit) Object.assign(r, update);
        return { data: single ? hit[0] ?? null : hit, error: null };
      }
      const hit = rows().filter(match);
      return { data: single ? hit[0] ?? null : hit, error: null };
    }
    const b: any = {
      select(cols?: string) { if (update === null && insert === null) selectCols = String(cols ?? ""); return b; },
      update(u: Row) { update = u; return b; },
      insert(i: Row) { insert = i; return b; },
      delete() { return b; },
      eq(c: string, v: unknown) { eqs.push([c, v]); return b; },
      in(c: string, v: unknown[]) { ins.push([c, v]); return b; },
      or() { return b; }, gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      is() { return b; }, ilike() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    return b;
  }
  return { from: (t: string) => chain(t) } as any;
}

// ── The §36 state machine ────────────────────────────────────────────────────

describe("MD274 — the §36 transition table", () => {
  it("owner_deleted is terminal and removed only yields to the owner", () => {
    for (const s of MEDIA_MODERATION_STATUSES) {
      if (s !== "owner_deleted") assert.equal(canTransition("owner_deleted", s), false, `owner_deleted → ${s}`);
    }
    assert.equal(canTransition("removed", "active"), false, "a take-down is not undone by an approval");
    assert.equal(canTransition("removed", "owner_deleted"), true);
  });

  it("reviewable states move freely; reject is reversible", () => {
    assert.equal(canTransition("processing", "active"), true);
    assert.equal(canTransition("active", "limited"), true);
    assert.equal(canTransition("rejected", "active"), true);
    assert.equal(canTransition("limited", "rejected"), true);
  });

  it("each decision lands in its §36 state", () => {
    assert.equal(stateForDecision("approve"), "active");
    assert.equal(stateForDecision("flag"), "limited");
    assert.equal(stateForDecision("reject"), "rejected");
    assert.equal(stateForDecision("remove"), "removed");
  });

  it("distribution: processing and active only — in either vocabulary", () => {
    for (const s of ["processing", "active", "pending", "approved"]) assert.equal(isDistributableModerationState(s), true, s);
    for (const s of ["limited", "rejected", "removed", "owner_deleted", "flagged", "banana", null]) {
      assert.equal(isDistributableModerationState(s), false, String(s));
    }
  });
});

// ── MediaModerationService.applyCanonicalModerationDecision ──────────────────

describe("MD351 — the decision reaches the file's canonical record", () => {
  afterEach(() => resetCanonicalSchemaMemo());
  const asset = (over: Row = {}) => ({
    id: "ma-1", storage_bucket: "post-media", storage_path: "u/a.jpg", moderation_status: "processing", version: 1, ...over,
  });

  it("moves the asset, as a compare-and-set that bumps the version", async () => {
    const tables = { media_assets: [asset()] };
    const out = await applyCanonicalModerationDecision(makeStore(tables), { bucket: "post-media", path: "u/a.jpg", decision: "reject" });
    assert.equal(out, "applied");
    assert.equal(tables.media_assets[0]!.moderation_status, "rejected");
    assert.equal(tables.media_assets[0]!.version, 2);
  });

  it("a flag lands as §36 'limited', not the legacy 'flagged'", async () => {
    const tables = { media_assets: [asset({ moderation_status: "approved" })] };
    assert.equal(await applyCanonicalModerationDecision(makeStore(tables), { bucket: "post-media", path: "u/a.jpg", decision: "flag" }), "applied");
    assert.equal(tables.media_assets[0]!.moderation_status, "limited");
  });

  it("never resurrects an owner-deleted file", async () => {
    const tables = { media_assets: [asset({ moderation_status: "owner_deleted" })] };
    assert.equal(
      await applyCanonicalModerationDecision(makeStore(tables), { bucket: "post-media", path: "u/a.jpg", decision: "approve" }),
      "refused_transition",
    );
    assert.equal(tables.media_assets[0]!.moderation_status, "owner_deleted");
    assert.equal(tables.media_assets[0]!.version, 1, "nothing was written");
  });

  it("re-reads and re-decides after losing the race — the concurrent writer is not overwritten blind", async () => {
    const tables = { media_assets: [asset()] };
    const out = await applyCanonicalModerationDecision(
      makeStore(tables, { failFirstCasOn: "media_assets" }),
      { bucket: "post-media", path: "u/a.jpg", decision: "reject" },
    );
    assert.equal(out, "applied");
    assert.equal(tables.media_assets[0]!.moderation_status, "rejected");
    assert.equal(tables.media_assets[0]!.version, 3, "the concurrent bump (2) and ours (3)");
  });

  it("writes nothing where the §36 CHECK does not exist (production today)", async () => {
    const tables = { media_assets: [asset({ moderation_status: "pending" })] };
    assert.equal(
      await applyCanonicalModerationDecision(makeStore(tables, { schemaMissing: true }), { bucket: "post-media", path: "u/a.jpg", decision: "approve" }),
      "refused_schema",
    );
    assert.equal(tables.media_assets[0]!.moderation_status, "pending");
  });

  it("a file with no canonical record reports no_asset", async () => {
    assert.equal(
      await applyCanonicalModerationDecision(makeStore({ media_assets: [] }), { bucket: "post-media", path: "u/a.jpg", decision: "reject" }),
      "no_asset",
    );
  });
});

// ── The admin route goes through the service ─────────────────────────────────

describe("MD351 — POST /admin/media/:id/moderate carries the decision to media_assets", () => {
  const ADMIN = "a0000000-0000-0000-0000-000000000001";
  const OWNER = "c0000000-0000-0000-0000-000000000003";
  const PM = "20000000-0000-0000-0000-000000000020";
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => { await close?.(); close = null; resetCanonicalSchemaMemo(); });

  async function moderate(tables: Record<string, Row[]>, body: unknown) {
    const store = makeStore(tables);
    store.auth = {
      getUser: async (t: string) => (t === "admin-token" ? { data: { user: { id: ADMIN } }, error: null } : { data: { user: null }, error: { message: "x" } }),
    };
    _setTestClient(store, true);
    _setTestServiceClient(store);
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
    app.use("/", adminMediaRouter);
    const srv = createServer(app);
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
    srv.unref();
    close = () => new Promise<void>((res) => { srv.closeAllConnections?.(); srv.close(() => res()); });
    const { port } = srv.address() as { port: number };
    const r = await fetch(`http://127.0.0.1:${port}/admin/media/${PM}/moderate`, {
      method: "POST",
      headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  }

  const tables = (assetStatus: string | null) => ({
    profiles: [{ id: ADMIN, role: "admin" }],
    moderation_actions: [],
    post_media: [{ id: PM, user_id: OWNER, moderation_status: "approved", storage_bucket: "post-media", storage_path: "u/a.jpg" }],
    media_assets: assetStatus === null ? [] : [{
      id: "ma-1", storage_bucket: "post-media", storage_path: "u/a.jpg", moderation_status: assetStatus, version: 1,
    }],
  });

  it("reject: post_media is rejected AND the canonical asset follows", async () => {
    const t = tables("processing");
    const { status, body } = await moderate(t, { action: "reject", target: "post_media" });
    assert.equal(status, 200);
    assert.equal(t.post_media[0]!.moderation_status, "rejected");
    assert.equal(t.media_assets[0]!.moderation_status, "rejected", "the second store no longer serves what the first rejected");
    assert.equal(body.canonical, "applied");
    assert.equal(t.moderation_actions.length, 1, "the audit row is still written");
  });

  it("flag: the canonical asset is §36 'limited'", async () => {
    const t = tables("active");
    await moderate(t, { action: "flag", target: "post_media" });
    assert.equal(t.media_assets[0]!.moderation_status, "limited");
  });

  it("approve on an owner-deleted file: post_media is approved, the asset stays deleted, and the response says so", async () => {
    const t = tables("owner_deleted");
    const { body } = await moderate(t, { action: "approve", target: "post_media" });
    assert.equal(t.media_assets[0]!.moderation_status, "owner_deleted");
    assert.equal(body.canonical, "refused_transition");
  });

  it("a file with no canonical record is moderated as before", async () => {
    const t = tables(null);
    const { status, body } = await moderate(t, { action: "reject", target: "post_media" });
    assert.equal(status, 200);
    assert.equal(t.post_media[0]!.moderation_status, "rejected");
    assert.equal(body.canonical, "no_asset");
  });
});

// ── The two readers that had to speak §36 ────────────────────────────────────

describe("§36 readers — Wall quick media blocks 'limited'; Telegraph shares 'active'", () => {
  const NOW = Date.parse("2026-09-04T12:00:00.000Z");
  const VIEWER = "viewer-1";

  function wallStore(moderation: string) {
    const store = makeStore({
      feature_flags: [{ flag: "wall_enabled", enabled: true }],
      user_follows: [{ follower_id: VIEWER, following_id: "aya" }],
      blocks: [],
      media_assets: [{
        id: "asset-1", owner_user_id: "aya", storage_bucket: "post-media", storage_path: "aya/a1.jpg",
        public_url: null, media_type: "image", thumbnail_path: null, thumbnail_url: null, width: 10, height: 10,
        duration_ms: null, moderation_status: moderation, processing_status: "ready", visibility: "inherit",
        created_at: new Date(NOW - 2 * 3_600_000).toISOString(),
      }],
      media_attachments: [{ media_asset_id: "asset-1", entity_type: "post", entity_id: "post-1" }],
      posts: [{ id: "post-1", author_id: "aya", visibility: "public", status: "active", post_status: "published", trip_id: null }],
      profiles: [{ id: "aya", display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" }],
    });
    return store;
  }

  it("a §36 'limited' asset never reaches the Quick Media row; an 'active' one does", async () => {
    const limited = await loadQuickMediaItems(wallStore("limited"), VIEWER, { nowMs: NOW });
    assert.deepEqual(limited.map((i: any) => i.id), [], "'limited' is restricted distribution");
    const active = await loadQuickMediaItems(wallStore("active"), VIEWER, { nowMs: NOW });
    assert.deepEqual(active.map((i: any) => i.id), ["asset-1"], "anti-vacuity: the fixture does reach the row");
  });

  it("a public §36 'active' asset is shareable to a non-owner; 'limited' and 'processing' are not", async () => {
    const state = async (moderation: string) => {
      const store = makeStore({
        media_assets: [{
          id: "ma-1", owner_user_id: "bob", caption: "x", alt_text: null, media_type: "image", thumbnail_url: null,
          public_url: "https://x/1.jpg", visibility: "public", moderation_status: moderation, processing_status: "ready",
          updated_at: "2026-05-01T00:00:00.000Z",
        }],
      });
      return (await shareableFor(store, "MEDIA", "ma-1")!.getCurrentState("alice")).available;
    };
    assert.equal(await state("active"), true, "the promoted §36 state is the promoted legacy state");
    assert.equal(await state("approved"), true);
    assert.equal(await state("limited"), false);
    assert.equal(await state("processing"), false);
  });
});
