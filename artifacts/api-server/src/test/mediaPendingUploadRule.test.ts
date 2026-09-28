/**
 * census-discovery §81 (lane W10-S2) — DV-77: the abandoned-upload sweep's RULE.
 * Register: D-W10S2-6 (§56.9 Q5).
 *
 * node:test + node:assert. An in-memory post_media table and an in-memory
 * bucket; no network.
 *
 * THE RULE. A pending slot is abandoned only when no upload can still land in
 * it under an authority the server issued: its latest activity — reservation,
 * a resumable session's renewal, or its newest part's write — is older than a
 * signed upload URL's lifetime (2 h, storage-js) plus an in-flight PUT's grace
 * (30 min). The one hour the route shipped swept a slot whose URL was still
 * live, including a resumable video its owner was still sending.
 *
 * WHAT IS PINNED
 *   R1  61 minutes after reservation, no activity since: KEPT (the old rule swept it).
 *   R2  a part written inside the window: KEPT, counted `stillSending`, however
 *       old the reservation.
 *   R3  a renewal (a session minted part URLs) inside the window: KEPT.
 *   R4  every activity older than 2 h 30: SWEPT — object, parts, then row.
 *   R5  an unreadable parts listing: KEPT and counted as an error — a deletion
 *       never runs on a guess about whether the owner is still sending.
 *   R6  the constants: 2 h is the installed storage-js's own statement, and
 *       the cutoff is exactly TTL + grace.
 *   R7  renewPendingSlot stamps only a still-pending row.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/mediaPendingUploadRule.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  sweepAbandonedPendingUploads,
  renewPendingSlot,
  SIGNED_UPLOAD_URL_TTL_MS,
  PENDING_UPLOAD_PUT_GRACE_MS,
  PENDING_UPLOAD_ORPHAN_CUTOFF_MS,
} from "../services/media/PendingUploadSweep.js";

const MIN = 60_000;
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const OWNER = "11111111-0000-4000-8000-000000000001";
const POST = "22222222-0000-4000-8000-000000000002";
const MEDIA = "33333333-0000-4000-8000-000000000003";
const PATH = `${OWNER}/${POST}/${MEDIA}.mp4`;

type Row = Record<string, unknown>;

function world(opts: { reservedMinAgo: number; renewedMinAgo?: number; partMinAgo?: number; listFails?: boolean }) {
  const rows: Row[] = [{
    id: MEDIA, user_id: OWNER, post_id: POST, storage_path: PATH, storage_bucket: "post-media",
    mime_type: "video/mp4", processing_status: "pending",
    created_at: new Date(NOW - opts.reservedMinAgo * MIN).toISOString(),
    updated_at: new Date(NOW - (opts.renewedMinAgo ?? opts.reservedMinAgo) * MIN).toISOString(),
  }];
  const objects = new Map<string, string | null>([[PATH, null]]);
  if (opts.partMinAgo !== undefined) objects.set(`${PATH}.parts/00000`, new Date(NOW - opts.partMinAgo * MIN).toISOString());

  function from(table: string) {
    assert.equal(table, "post_media");
    const preds: Array<(r: Row) => boolean> = [];
    let op: { kind: "select" } | { kind: "delete" } | { kind: "update"; patch: Row } = { kind: "select" };
    let single = false;
    const run = () => {
      const hit = rows.filter((r) => preds.every((p) => p(r)));
      if (op.kind === "delete") { for (const r of hit) rows.splice(rows.indexOf(r), 1); return { data: null, error: null }; }
      if (op.kind === "update") { for (const r of hit) Object.assign(r, op.patch); return { data: null, error: null }; }
      return single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      delete: () => { op = { kind: "delete" }; return b; },
      update: (patch: Row) => { op = { kind: "update", patch }; return b; },
      eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b; },
      lt: (c: string, v: string) => { preds.push((r) => String(r[c]) < v); return b; },
      order: () => b,
      limit: () => b,
      maybeSingle: () => { single = true; return Promise.resolve(run()); },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return b;
  }
  const storage = {
    from: () => ({
      async remove(paths: string[]) { for (const p of paths) objects.delete(p); return { data: paths, error: null }; },
      async list(folder: string) {
        if (opts.listFails) return { data: null, error: { message: "listing unavailable" } };
        const prefix = `${folder}/`;
        return {
          data: [...objects.entries()].filter(([k]) => k.startsWith(prefix))
            .map(([k, t]) => ({ name: k.slice(prefix.length), updated_at: t, created_at: t, metadata: { size: 4 } })),
          error: null,
        };
      },
    }),
  };
  return { sc: { from, storage } as never, rows, objects };
}

async function pass(w: ReturnType<typeof world>) {
  const r = await sweepAbandonedPendingUploads(w.sc, { nowMs: NOW, log: {} });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) throw new Error("unreachable");
  return r;
}

describe("the rule", () => {
  it("R1 — 61 minutes after reservation, nothing since: KEPT (its upload URL is still live)", async () => {
    const w = world({ reservedMinAgo: 61 });
    const r = await pass(w);
    assert.equal(r.swept, 0);
    assert.equal(w.rows.length, 1);
    assert.ok(w.objects.has(PATH));
  });

  it("R2 — reserved 10 hours ago, a part written 20 minutes ago: KEPT, and counted as still sending", async () => {
    const w = world({ reservedMinAgo: 600, partMinAgo: 20 });
    const r = await pass(w);
    assert.equal(r.swept, 0);
    assert.equal(r.stillSending, 1);
    assert.equal(w.rows.length, 1);
    assert.ok(w.objects.has(`${PATH}.parts/00000`));
  });

  it("R3 — reserved 10 hours ago, renewed by a session 90 minutes ago: KEPT", async () => {
    const w = world({ reservedMinAgo: 600, renewedMinAgo: 90 });
    const r = await pass(w);
    assert.equal(r.swept, 0);
    assert.equal(r.stillSending, 1);
  });

  it("R4 — every activity older than 2 h 30: SWEPT, bytes and parts first, then the row", async () => {
    const w = world({ reservedMinAgo: 600, renewedMinAgo: 200, partMinAgo: 151 });
    const r = await pass(w);
    assert.equal(r.swept, 1);
    assert.equal(w.rows.length, 0);
    assert.equal(w.objects.size, 0);
  });

  it("R4b — the edge: 149 minutes kept, 151 minutes swept", async () => {
    assert.equal((await pass(world({ reservedMinAgo: 149 }))).swept, 0);
    assert.equal((await pass(world({ reservedMinAgo: 151 }))).swept, 1);
  });

  it("R5 — an unreadable parts listing: KEPT, counted as an error", async () => {
    const w = world({ reservedMinAgo: 600, listFails: true });
    const r = await pass(w);
    assert.equal(r.swept, 0);
    assert.equal(r.errors, 1);
    assert.equal(w.rows.length, 1);
  });
});

describe("R6 — the constants are derived, not chosen", () => {
  it("the 2 h lifetime is the installed storage-js's own statement", () => {
    const req = createRequire(import.meta.url);
    const sbDir = path.dirname(req.resolve("@supabase/supabase-js/package.json"));
    const candidates = [path.join(sbDir, "..", "storage-js", "dist"), path.join(sbDir, "node_modules", "@supabase", "storage-js", "dist")];
    const dist = candidates.find((d) => existsSync(d));
    assert.ok(dist, "fixture: storage-js is not installed beside supabase-js");
    const typings = readdirSync(dist!).filter((f) => /\.d\.(m|c)?ts$/.test(f)).map((f) => readFileSync(path.join(dist!, f), "utf8")).join("\n");
    assert.match(typings, /Signed upload URLs[\s\S]{0,200}valid for 2 hours/);
    assert.equal(SIGNED_UPLOAD_URL_TTL_MS, 2 * 60 * MIN);
  });

  it("the cutoff is exactly the URL lifetime plus the in-flight grace", () => {
    assert.equal(PENDING_UPLOAD_PUT_GRACE_MS, 30 * MIN);
    assert.equal(PENDING_UPLOAD_ORPHAN_CUTOFF_MS, SIGNED_UPLOAD_URL_TTL_MS + PENDING_UPLOAD_PUT_GRACE_MS);
  });
});

describe("R7 — renewal", () => {
  it("stamps a pending row, and never a ready one", async () => {
    const w = world({ reservedMinAgo: 600 });
    assert.ok((await renewPendingSlot(w.sc, MEDIA, NOW)).ok);
    assert.equal(w.rows[0]!.updated_at, new Date(NOW).toISOString());
    w.rows[0]!.processing_status = "ready";
    w.rows[0]!.updated_at = "2026-01-01T00:00:00.000Z";
    assert.ok((await renewPendingSlot(w.sc, MEDIA, NOW)).ok);
    assert.equal(w.rows[0]!.updated_at, "2026-01-01T00:00:00.000Z");
  });
});

describe("R8 — the resumable session renews the slot BEFORE it mints part URLs", () => {
  it("renewal precedes minting, and a failed renewal mints nothing", () => {
    const src = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "routes", "postcardMediaTransport.ts"), "utf8");
    const renew = src.indexOf("await renewPendingSlot(ctx.sc, slot.id)");
    const mint = src.indexOf("await mintPartUploadUrls(bucket, slot.storage_path, summary.missing)");
    assert.ok(renew > 0 && mint > renew, "the session must renew the slot before minting");
    assert.match(src.slice(renew, mint), /const minted = renewed\.ok \?/, "a failed renewal must not reach the minting");
  });
});
