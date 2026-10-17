import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const moduleName = process.argv[2] ? pathToFileURL(process.argv[2]).href : "@electric-sql/pglite";
const { PGlite } = await import(moduleName);
const database = new PGlite();
const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const asset = "33333333-3333-4333-8333-333333333333";
const otherToken = "44444444-4444-4444-8444-444444444444";
let assertions = 0;

async function scalar(query, parameters = []) {
  const answer = await database.query(query, parameters);
  return Object.values(answer.rows[0] ?? {})[0];
}
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  assertions += 1;
}
async function enqueue(model = "hls-v1", sourceVersion = 1, ownerId = owner) {
  return scalar("SELECT media_derivative_enqueue($1,$2,$3,'adaptive_video',$4)", [asset, ownerId, sourceVersion, model]);
}
async function claim(model = "hls-v1") {
  return (await database.query("SELECT * FROM media_derivative_claim('adaptive_video',$1,1,120)", [model])).rows;
}
async function finish(job, success, retryable = false, result = null, lease = job.lease_token) {
  return scalar("SELECT media_derivative_finish($1,$2,$3,$4,'fixture_failure',1,100,50,$5::jsonb)", [job.id, lease, success, retryable, result === null ? null : JSON.stringify(result)]);
}

try {
  await database.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean NOT NULL, description text);
    CREATE TABLE public.media_assets(id uuid PRIMARY KEY, owner_user_id uuid, version integer, storage_bucket text, storage_path text,
      size_bytes bigint, deleted_at timestamptz, purge_status text, processing_status text, moderation_status text);
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.media_assets, public.feature_flags TO service_role;
  `);
  await database.exec(await readFile(new URL("../../artifacts/api-server/src/migrations/3980_media_derivative_jobs.sql", import.meta.url), "utf8"));
  await database.query("INSERT INTO media_assets VALUES($1,$2,1,'post-media','owner/clip.mp4',100,NULL,'not_requested','ready','approved')", [asset, owner]);
  await database.exec("SET ROLE service_role");
  equal(await enqueue(), null, "disabled queue must not write");
  await database.exec("UPDATE feature_flags SET enabled = true WHERE flag = 'media_derivative_jobs_enabled'");
  equal(await enqueue("wrong-owner", 1, otherOwner), null, "owner mismatch refused");
  equal(await enqueue("stale", 2), null, "source generation mismatch refused");
  const first = await enqueue();
  equal(await enqueue(), first, "idempotent duplicate returns existing job");
  equal(await scalar("SELECT count(*)::integer FROM media_derivative_jobs"), 1, "one durable job");
  const claimed = (await claim())[0];
  equal(claimed.source_path, "owner/clip.mp4", "source snapshot persisted");
  equal(claimed.attempts, 1, "claim increments attempts");
  equal((await claim()).length, 0, "active lease cannot be claimed twice");
  equal(await finish(claimed, true, false, {}, otherToken), false, "foreign lease cannot publish");
  equal(await scalar("SELECT media_derivative_renew($1,$2,120)", [claimed.id, claimed.lease_token]), true, "owned lease renewable");
  equal(await finish(claimed, true, false, { directory: "private-generation-one" }), true, "owned completion succeeds");
  equal(await scalar("SELECT count(*)::integer FROM media_derivative_job_events WHERE job_id=$1", [first]), 3, "queued, processing and completion audit entries");
  equal(await scalar("SELECT media_derivative_ready($1,1,'adaptive_video','hls-v1')->>'directory'", [asset]), "private-generation-one", "current completion resolvable");
  equal(await scalar("SELECT media_derivative_cancel_asset($1)", [asset]), false, "cannot tombstone still-live source by accident");
  await database.exec("UPDATE feature_flags SET enabled=false WHERE flag='media_derivative_jobs_enabled'");
  equal(await scalar("SELECT media_derivative_ready($1,1,'adaptive_video','hls-v1')", [asset]), null, "switch-off hides derived playback pointers");
  await database.exec("UPDATE feature_flags SET enabled=true WHERE flag='media_derivative_jobs_enabled'");
  equal(await scalar("SELECT result->>'directory' FROM media_derivative_jobs WHERE id=$1", [first]), "private-generation-one", "result retained for playback");
  equal(await finish(claimed, true), false, "replayed completion refused");
  for (const operation of ["finish", "renew"]) {
    await enqueue(`expired-${operation}`);
    const expiring = (await claim(`expired-${operation}`))[0];
    await database.exec("BEGIN");
    try {
      await database.query("UPDATE media_derivative_jobs SET lease_until=now()+interval '20 milliseconds' WHERE id=$1", [expiring.id]);
      await delay(65);
      equal(await scalar("SELECT lease_until < clock_timestamp() AND lease_until > now() FROM media_derivative_jobs WHERE id=$1", [expiring.id]), true, "fixture lease expires after transaction start");
      const accepted = operation === "finish" ? await finish(expiring, true)
        : await scalar("SELECT media_derivative_renew($1,$2,120)", [expiring.id, expiring.lease_token]);
      equal(accepted, false, `${operation} refuses expiry after transaction start`);
      equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [expiring.id]), "processing", "expired lease never publishes or changes state");
    } finally { await database.exec("ROLLBACK"); }
  }
  await enqueue("fresh-clock");
  await database.exec("BEGIN");
  try {
    await delay(65);
    const fresh = (await claim("fresh-clock"))[0];
    equal(await scalar("SELECT lease_until > now()+interval '120.04 seconds' FROM media_derivative_jobs WHERE id=$1", [fresh.id]), true, "claim expiry is measured from wall clock, not old transaction start");
    await delay(65);
    equal(await scalar("SELECT media_derivative_renew($1,$2,120)", [fresh.id, fresh.lease_token]), true, "live delayed transaction can renew");
    equal(await scalar("SELECT lease_until > $2::timestamptz+interval '0.04 seconds' FROM media_derivative_jobs WHERE id=$1", [fresh.id, fresh.lease_until]), true, "renewal receives a fresh wall-clock lease");
  } finally { await database.exec("ROLLBACK"); }
  await enqueue("recover-clock");
  const recoverClock = (await claim("recover-clock"))[0];
  await database.exec("BEGIN");
  try {
    await database.query("UPDATE media_derivative_jobs SET lease_until=now()+interval '20 milliseconds' WHERE id=$1", [recoverClock.id]);
    await delay(65);
    equal(await scalar("SELECT media_derivative_recover(100)"), 1, "recovery observes expiry since transaction start");
    equal(await scalar("SELECT available_at > now()+interval '30.04 seconds' FROM media_derivative_jobs WHERE id=$1", [recoverClock.id]), true, "recovery backoff starts at wall clock");
  } finally { await database.exec("ROLLBACK"); }
  const schemaTables = ["media_derivative_jobs", "media_caption_manifests", "media_visual_embeddings", "media_image_understanding_artifacts", "media_dubbing_artifacts"];
  equal(await scalar("SELECT media_derivative_schema_status()"), Object.fromEntries(schemaTables.map(name => [name, name === "media_derivative_jobs"])), "schema status distinguishes installed queue from missing feature tables");
  await database.exec("UPDATE feature_flags SET enabled=false WHERE flag='media_derivative_jobs_enabled'");
  equal(await scalar("SELECT media_derivative_schema_status()->>'media_derivative_jobs'"), "true", "disabled marker does not hide installed schema from deletion");
  await database.exec("UPDATE feature_flags SET enabled=true WHERE flag='media_derivative_jobs_enabled'");
  equal(await scalar("SELECT NOT prosecdef AND pronargs=0 AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc WHERE oid='media_derivative_schema_status()'::regprocedure"), true, "schema status is no-argument invoker with fixed catalog path");
  await database.exec("RESET ROLE; BEGIN");
  try {
    for (const name of schemaTables.slice(1)) await database.exec(`CREATE TABLE public.${name}(id integer)`);
    await database.exec("SET LOCAL ROLE service_role");
    equal(await scalar("SELECT media_derivative_schema_status()"), Object.fromEntries(schemaTables.map(name => [name, true])), "schema status sees installed feature tables independently of PostgREST cache");
  } finally { await database.exec("ROLLBACK; SET ROLE service_role"); }
  await database.exec("UPDATE media_assets SET version=2");
  equal(await scalar("SELECT media_derivative_ready($1,1,'adaptive_video','hls-v1')", [asset]), null, "stale generation never resolves");
  equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [first]), "cancelled", "source update revokes completed output");
  await enqueue("path-change", 2);
  const pathJob = (await claim("path-change"))[0];
  await database.exec("UPDATE media_assets SET storage_path='owner/replaced.mp4'");
  equal(await finish(pathJob, true), false, "path replacement without version bump still revokes");
  await database.exec("UPDATE media_assets SET moderation_status=NULL");
  equal(await enqueue("unknown-moderation", 2), null, "unknown moderation fails closed");
  await database.exec("UPDATE media_assets SET moderation_status='flagged'");
  equal(await enqueue("held", 2), null, "flagged content not queued for advanced work");
  await database.exec("UPDATE media_assets SET moderation_status='approved'");
  await enqueue("retry", 2);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const attemptJob = (await claim("retry"))[0];
    equal(attemptJob.attempts, attempt, "attempt counter advances");
    equal(await finish(attemptJob, false, true), true, "failed attempt recorded");
    equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [attemptJob.id]), attempt < 5 ? "retrying" : "failed", "bounded retry/dead letter");
    equal(await scalar("SELECT available_at > now() FROM media_derivative_jobs WHERE id=$1", [attemptJob.id]), true, "retry has delay");
    await database.exec("UPDATE media_derivative_jobs SET available_at=now()-interval '1 second' WHERE model_version='retry'");
  }
  equal((await claim("retry")).length, 0, "dead letter does not run again");
  await enqueue("crash", 2);
  const crashed = (await claim("crash"))[0];
  await database.query("UPDATE media_derivative_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [crashed.id]);
  equal(await finish(crashed, true), false, "expired worker cannot complete");
  equal(await scalar("SELECT media_derivative_recover(100)"), 1, "crashed lease recovered");
  equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [crashed.id]), "retrying", "crash goes to delayed retry");
  await database.exec("UPDATE media_assets SET deleted_at=now(),purge_status='pending'");
  equal(await scalar("SELECT media_derivative_cancel_asset($1)", [asset]), true, "revoked source tombstone confirmed before erasure");
  equal(await enqueue("deleted", 2), null, "deleted source cannot enqueue");
  equal(await scalar("SELECT count(*)::integer FROM media_derivative_jobs WHERE state <> 'cancelled'"), 0, "deletion cancels all generations");
  equal(await scalar("SELECT count(*)::integer FROM media_derivative_jobs WHERE result IS NOT NULL"), 1, "erasure pointers preserved until cleanup");
  for (const role of ["anon", "authenticated"]) {
    await database.exec(`RESET ROLE; SET ROLE ${role}`);
    await assert.rejects(database.query("SELECT * FROM media_derivative_jobs"), /permission denied/);
    assertions += 1;
    await assert.rejects(database.query("SELECT * FROM media_derivative_job_events"), /permission denied/);
    assertions += 1;
    await assert.rejects(database.query("SELECT media_derivative_claim('adaptive_video','hls-v1',1,120)"), /permission denied/);
    assertions += 1;
    await assert.rejects(database.query("SELECT media_derivative_schema_status()"), /permission denied/);
    assertions += 1;
  }
  await database.exec("RESET ROLE; DELETE FROM media_assets");
  equal(await scalar("SELECT count(*)::integer FROM media_derivative_jobs"), 0, "canonical hard deletion cascades rows");
  console.log(JSON.stringify({ passed: assertions, database: "isolated in-memory PGlite", network: false, realPostgresConcurrencyTested: false }));
} finally {
  await database.close();
}
