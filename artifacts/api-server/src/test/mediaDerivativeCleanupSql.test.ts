import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retryFailedMediaPurges } from "../services/media/MediaLifecycleService.js";
import { AdaptiveOrphanReconciler } from "../services/media/AdaptiveOrphanReconciler.js";
import { AdaptiveArtifacts } from "../lib/media/adaptive/artifacts.js";

test("offline PostgreSQL cleanup CAS, role boundary, generation trigger and hard-delete FK cascade", { skip: !process.env.MEDIA_CLEANUP_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.MEDIA_CLEANUP_PGLITE_MODULE!);
  const database = new PGlite();
  const root = await realpath(await mkdtemp(join(tmpdir(), "cleanup-pg-")));
  const owner = "10000000-0000-4000-a000-000000000001";
  const asset = "20000000-0000-4000-a000-000000000001";
  let failRemove = true;
  let reconciler: AdaptiveOrphanReconciler | null = null;
  const identifier = (value: string) => { assert.match(value, /^[a-z_][a-z0-9_]*$/); return `"${value}"`; };
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
  const client = {
    from(table: string) {
      const filters: { key: string; operator: string; value: unknown }[] = [];
      const orders: string[] = [];
      let maximum = 50;
      let single = false;
      let update: Record<string, unknown> | null = null;
      let insert: Record<string, unknown> | null = null;
      const query = {
        select() { return query; }, eq(key: string, value: unknown) { filters.push({ key, operator: "=", value }); return query; },
        lte(key: string, value: unknown) { filters.push({ key, operator: "<=", value }); return query; },
        not(key: string, operator: string, value: unknown) { assert.equal(operator, "is"); assert.equal(value, null); filters.push({ key, operator: "IS NOT NULL", value }); return query; },
        in(key: string, value: unknown[]) { filters.push({ key, operator: "IN", value }); return query; },
        limit(value: number) { maximum = value; return query; }, order(key: string) { orders.push(identifier(key)); return query; },
        update(value: Record<string, unknown>) { update = value; return query; }, insert(value: Record<string, unknown>) { insert = value; return query; },
        maybeSingle() { single = true; return query; }, abortSignal() { return query; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return (async () => {
            const parameters: unknown[] = [];
            const parameter = (value: unknown) => { parameters.push(value); return `$${parameters.length}`; };
            const where = filters.map(filter => `${identifier(filter.key)} ${filter.operator} ${filter.operator === "IS NOT NULL" ? ""
              : filter.operator === "IN" ? `(${(filter.value as unknown[]).map(parameter).join(",")})` : parameter(filter.value)}`).join(" AND ") || "true";
            let sql: string;
            if (insert) {
              const entries = Object.entries(insert);
              sql = `INSERT INTO ${identifier(table)} (${entries.map(([key]) => identifier(key)).join(",")}) VALUES (${entries.map(([, value]) => parameter(typeof value === "object" ? JSON.stringify(value) : value)).join(",")}) RETURNING *`;
            } else if (update) {
              sql = `UPDATE ${identifier(table)} SET ${Object.entries(update).map(([key, value]) => `${identifier(key)}=${parameter(value)}`).join(",")} WHERE ${where} RETURNING *`;
            } else {
              sql = `SELECT * FROM ${identifier(table)} WHERE ${where}${orders.length ? ` ORDER BY ${orders.join(",")}` : ""} LIMIT ${maximum}`;
            }
            try {
              const rows = normalize((await database.query(sql, parameters)).rows);
              return { data: single ? rows[0] ?? null : rows, error: null };
            } catch (error) { return { data: null, error }; }
          })().then(resolve, reject);
        },
      };
      return query;
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      const entries = Object.entries(args);
      return database.query(`SELECT public.${identifier(name)}(${entries.map(([key], index) => `${identifier(key)} => $${index + 1}`).join(",")}) AS result`, entries.map(([, value]) => value))
        .then((answer: any) => ({ data: normalize(answer.rows[0].result), error: null }), (error: unknown) => ({ data: null, error }));
    },
    storage: { from: () => ({ async remove(paths: string[]) {
      if (failRemove) return { error: new Error("synthetic storage failure") };
      for (const path of paths) await unlink(join(root, path)).catch(error => { if (error.code !== "ENOENT") throw error; });
      return { error: null };
    } }) },
  } as unknown as SupabaseClient;
  try {
    await database.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.media_assets(id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, version integer NOT NULL,
        storage_bucket text NOT NULL, storage_path text NOT NULL, size_bytes bigint, thumbnail_path text, media_type text,
        deleted_at timestamptz, purge_status text NOT NULL, purge_error text, purged_at timestamptz, updated_at timestamptz,
        processing_status text, moderation_status text);
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
      CREATE TABLE public.media_asset_lifecycle_events(media_asset_id uuid REFERENCES media_assets(id) ON DELETE CASCADE,
        actor_user_id uuid, event_type text, details jsonb);
      GRANT SELECT,INSERT,UPDATE,DELETE ON media_assets,feature_flags,media_asset_lifecycle_events TO service_role;`);
    const migration = await readFile(new URL("../migrations/3320_media_canonical_contract_constraints.sql", import.meta.url), "utf8");
    const trigger = migration.match(/CREATE OR REPLACE FUNCTION public\.media_assets_bump_version\(\)[\s\S]*?EXECUTE FUNCTION public\.media_assets_bump_version\(\);/);
    assert.ok(trigger);
    await database.exec(trigger[0]);
    await database.exec(await readFile(new URL("../migrations/3980_media_derivative_jobs.sql", import.meta.url), "utf8"));
    await database.query(`INSERT INTO media_assets(id,owner_user_id,version,storage_bucket,storage_path,size_bytes,media_type,deleted_at,purge_status,updated_at,processing_status,moderation_status)
      VALUES($1,$2,4,'post-media',$3,100,'video','2025-01-01','failed','2025-01-01','removed','owner_deleted')`, [asset, owner, `${owner}/original.mp4`]);
    await database.exec("SET ROLE service_role");
    await mkdir(join(root, owner));
    await writeFile(join(root, owner, "original.mp4"), "synthetic original bytes");
    assert.equal((await retryFailedMediaPurges(client, { env: {} })).failed, 1);
    let row = (await database.query("SELECT * FROM media_assets")).rows[0];
    assert.equal(row.purge_status, "failed");
    assert.equal(row.version, 6);
    assert.equal(row.moderation_status, "owner_deleted");
    assert.equal((await retryFailedMediaPurges(client, { env: {} })).attempted, 0);
    await database.exec("UPDATE media_assets SET updated_at='2025-01-01'");
    failRemove = false;
    const attempts = await Promise.all([retryFailedMediaPurges(client, { env: {} }), retryFailedMediaPurges(client, { env: {} })]);
    assert.equal(attempts.reduce((total, result) => total + result.completed, 0), 1);
    row = (await database.query("SELECT * FROM media_assets")).rows[0];
    assert.equal(row.purge_status, "completed");
    assert.equal(row.version, 9);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM media_asset_lifecycle_events WHERE event_type='purge_succeeded'")).rows[0].count, 1);
    await assert.rejects(readFile(join(root, owner, "original.mp4")), { code: "ENOENT" });
    await database.exec("RESET ROLE; SET ROLE authenticated");
    await assert.rejects(retryFailedMediaPurges(client, { env: {} }), /unavailable/);
    await database.exec("RESET ROLE; SET ROLE service_role");
    await database.exec("UPDATE media_assets SET deleted_at=NULL,purge_status='not_requested',processing_status='ready',moderation_status='approved'; UPDATE feature_flags SET enabled=true WHERE flag='media_derivative_jobs_enabled'");
    row = (await database.query("SELECT * FROM media_assets")).rows[0];
    await database.query("SELECT media_derivative_enqueue($1,$2,$3,'adaptive_video','hls-v1')", [asset, owner, row.version]);
    const job = (await database.query("SELECT * FROM media_derivative_claim('adaptive_video','hls-v1',1,900)")).rows[0];
    assert.ok(job);
    const volume = join(root, "adaptive");
    await new AdaptiveArtifacts(volume).initialize();
    const directory = join(volume, "outputs", `${asset}-${row.version}-${job.lease_token ?? randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "master.m3u8"), "synthetic private playlist");
    let clock = Date.now();
    reconciler = new AdaptiveOrphanReconciler(client, volume, { now: () => clock });
    assert.equal((await reconciler.runPass()).removed, 0);
    await database.query("DELETE FROM media_assets WHERE id=$1", [asset]);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM media_derivative_jobs")).rows[0].count, 0);
    assert.equal((await reconciler.runPass()).observed, 1);
    clock += 1800001;
    assert.equal((await reconciler.runPass()).removed, 1);
    await assert.rejects(readFile(join(directory, "master.m3u8")), { code: "ENOENT" });
  } finally {
    await reconciler?.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
