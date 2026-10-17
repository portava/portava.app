import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDubbingHandler } from "../../artifacts/api-server/src/lib/media/dubbing/handler.js";
import { createDubbingStore } from "../../artifacts/api-server/src/lib/media/dubbing/store.js";
import { DUBBING_DISCLOSURE_VERSION, DubbingError } from "../../artifacts/api-server/src/lib/media/dubbing/contracts.js";
import { dubbingRevision, renderDubbing } from "../../artifacts/api-server/src/lib/media/dubbing/render.js";

if (!process.argv[2] || !process.argv[3]) throw new Error("Provide installed PGlite module entrypoint and parent 3980 migration path; no downloads");
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const { createMediaJobQueue, MediaJobError } = await import(pathToFileURL(resolve(dirname(process.argv[3]), "../lib/media/jobs/queue.ts")).href);
const { runMediaWorkerPass } = await import(pathToFileURL(resolve(dirname(process.argv[3]), "../lib/media/jobs/worker.ts")).href);
const database = new PGlite();
let checks = 0;
function equal(actual: unknown, expected: unknown, label: string) { assert.deepEqual(actual, expected, label); checks++; }
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const asset = "33333333-3333-4333-8333-333333333333";
const badToken = "44444444-4444-4444-8444-444444444444";
const engine = { id: "test-tone-not-speech", modelVersion: "fixture-1", language: "en-US", async synthesize() { return { sampleRate: 24000, samples: Buffer.alloc(12000, 20) }; } };
const source = { assetId: asset, ownerId: owner, sourceVersion: 1, targetLanguage: "en-US", captionRevision: "a".repeat(64), translationRevision: "b".repeat(64), durationMs: 2000, cues: [{ startMs: 500, endMs: 1500, text: "Invented sentence" }] };
const storage = new Map<string, Buffer>();
let publicBucket = false;
let uploadFailure = false;
let cleanupFailure = false;
let viewerAllowed = true;
let uploadCount = 0;
let cancelDuringDownload = false;
let uploadGate: Promise<void> | undefined;
let uploadBegan: (() => void) | undefined;
let lateUpload: { path: string; bytes: Buffer } | undefined;
let ambiguousUpload = false;
let cancelAfterReservation: (() => void) | undefined;
async function scalar(sql: string, values: unknown[] = []) { return Object.values((await database.query(sql, values)).rows[0] ?? {})[0]; }
async function dbAnswer(operation: () => Promise<unknown>) {
  try { return { data: await operation(), error: null }; } catch (error) { return { data: null, error }; }
}
function table(name: string) {
  assert(["media_assets", "media_dubbing_consents", "media_dubbing_artifacts", "media_dubbing_readable"].includes(name));
  const predicates: string[] = [];
  const parameters: unknown[] = [];
  let columns = "*";
  let removing = false;
  let limit = "";
  let order = "";
  let single = false;
  const builder: any = {
    select(value: string) { assert(/^[a-z_,]+$/.test(value)); columns = value; return builder; },
    delete() { removing = true; return builder; },
    eq(column: string, value: unknown) {
      assert(/^[a-z_]+$/.test(column) || /^manifest->>(language|revisionKey|sha256)$/.test(column));
      parameters.push(value); predicates.push(`${column.startsWith("manifest->>") ? `manifest->>'${column.slice(11)}'` : column} = $${parameters.length}`); return builder;
    },
    limit(value: number) { assert(Number.isInteger(value) && value > 0 && value <= 100); limit = ` LIMIT ${value}`; return builder; },
    order(column: string) { assert.equal(column, "created_at"); order = " ORDER BY created_at DESC"; return builder; },
    maybeSingle() { single = true; return builder; },
    then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
      const sql = removing ? `DELETE FROM ${name}${where} RETURNING ${columns}` : `SELECT ${columns} FROM ${name}${where}${order}${limit}`;
      return dbAnswer(async () => { const result = (await database.query(sql, parameters)).rows; return single ? result[0] ?? null : result; }).then(resolve, reject);
    },
  };
  return builder;
}
const client: any = {
  from: table,
  rpc(name: string, parameters: Record<string, unknown>) {
    assert(/^media_(?:dubbing|derivative)_[a-z_]+$/.test(name));
    const values = Object.values(parameters);
    const named = Object.keys(parameters).map((key, index) => { assert(/^p_[a-z_]+$/.test(key)); return `${key} => $${index + 1}`; }).join(",");
    const execute = () => dbAnswer(async () => {
      const result = name === "media_derivative_claim"
        ? JSON.parse(JSON.stringify((await database.query(`SELECT * FROM ${name}(${named})`, values)).rows))
        : await scalar(`SELECT ${name}(${named})`, values);
      if (name === "media_dubbing_stage" && result === true) cancelAfterReservation?.();
      return result;
    });
    return {
      then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) { return execute().then(resolve, reject); },
      abortSignal(signal: AbortSignal) { if (signal.aborted) return Promise.reject(signal.reason); return execute(); },
    };
  },
  storage: {
    async getBucket() { return { data: { public: publicBucket }, error: null }; },
    from(name: string) {
      assert(["media-private-fixture", "other-private-fixture"].includes(name));
      return {
        async upload(filename: string, bytes: Buffer, options: any) {
          uploadCount++; equal(options.upsert, false, "never replace a source/output");
          if (uploadFailure) return { error: new Error("synthetic storage failure") };
          const copy = Buffer.from(bytes);
          uploadBegan?.();
          if (uploadGate) await uploadGate;
          if (ambiguousUpload) { lateUpload = { path: filename, bytes: copy }; return { error: new Error("response lost while remote write remains possible") }; }
          if (storage.has(filename)) return { error: new Error("already exists") };
          storage.set(filename, copy); return { error: null };
        },
        async remove(paths: string[]) {
          assert.equal(name, "media-private-fixture");
          if (cleanupFailure) return { error: new Error("synthetic remove failure") };
          for (const filename of paths) storage.delete(filename);
          return { error: null };
        },
        async download(filename: string) {
          const bytes = storage.get(filename);
          if (cancelDuringDownload) await database.exec("UPDATE media_derivative_jobs SET state='cancelled',result=NULL WHERE kind='dubbing'");
          return bytes ? { data: new Blob([bytes]), error: null } : { data: null, error: new Error("missing") };
        },
      };
    },
  },
};
const store = createDubbingStore(client, "media-private-fixture", { loadTranslatedSource: async () => structuredClone(source), canRead: async () => viewerAllowed });
const grant = async (actorId = owner, expectedConsentRevision?: string) => store.grantAndLoad({ assetId: asset, actorId, targetLanguage: "en-US", disclosureVersion: DUBBING_DISCLOSURE_VERSION, expectedConsentRevision: expectedConsentRevision ?? (await store.consentState({ assetId: asset, actorId, targetLanguage: "en-US" })).consentRevision });
async function claimed(input: any) {
  const id = await scalar("SELECT media_derivative_enqueue($1,$2,1,'dubbing','fixture-1','en-US',$3)", [asset, owner, dubbingRevision(input, engine)]);
  const row = (await database.query("SELECT * FROM media_derivative_claim('dubbing','fixture-1',1,120)")).rows[0];
  assert(row && row.id === id);
  return { job: { id: row.id, token: row.lease_token, assetId: asset, ownerUserId: owner, sourceVersion: 1, targetLanguage: "en-US", kind: "dubbing" as const, modelVersion: "fixture-1", revisionKey: row.revision_key, bucket: "post-media" as const, path: row.source_path, sizeBytes: row.source_bytes, attempt: row.attempts, leaseUntil: row.lease_until }, signal: new AbortController().signal, isCurrent: async () => true };
}
try {
  await database.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE feature_flags(flag text PRIMARY KEY, enabled boolean NOT NULL, description text); CREATE TABLE media_assets(id uuid PRIMARY KEY, owner_user_id uuid, version integer, storage_bucket text, storage_path text, size_bytes bigint, deleted_at timestamptz, purge_status text, processing_status text, moderation_status text); GRANT ALL ON feature_flags,media_assets TO service_role;");
  await database.exec("CREATE TABLE media_caption_manifests(asset_id uuid PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE, source_version integer NOT NULL, revision_key text NOT NULL, object_path text); GRANT SELECT,INSERT,UPDATE,DELETE ON media_caption_manifests TO service_role;");
  await database.exec(await readFile(process.argv[3], "utf8"));
  await database.exec(await readFile(new URL("../../artifacts/api-server/src/migrations/3986_media_synthetic_dubbing.sql", import.meta.url), "utf8"));
  await database.query("INSERT INTO media_assets VALUES($1,$2,1,'post-media','owner/original.mp4',100,NULL,'none','ready','approved')", [asset, owner]);
  await database.query("INSERT INTO media_caption_manifests VALUES($1,1,$2,$3)", [asset, source.captionRevision, `manual-captions/${asset}/v1-${source.captionRevision}.json`]);
  for (const role of ["anon", "authenticated"]) {
    equal(await scalar("SELECT has_table_privilege($1,'media_dubbing_artifacts','SELECT')", [role]), false, `${role} cannot read artifacts`);
    equal(await scalar("SELECT has_function_privilege($1,'media_dubbing_grant(uuid,uuid,integer,text,text,text,boolean,text,text)','EXECUTE')", [role]), false, `${role} cannot grant consent`);
    equal(await scalar("SELECT has_table_privilege($1,'media_dubbing_consents','DELETE')", [role]), false, `${role} cannot tamper with consent`);
    for (const signature of ["media_dubbing_stage(uuid,uuid,uuid,jsonb,text)", "media_dubbing_settle(uuid,uuid,uuid,boolean)", "media_dubbing_retire(uuid,uuid,uuid,uuid)", "media_dubbing_forget(uuid,uuid,uuid,uuid)"]) {
      equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE')", [role, signature]), false, `${role} cannot invoke ${signature}`);
    }
  }
  await database.exec("SET ROLE service_role");
  await assert.rejects(grant()); checks++;
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_consents"), 0, "default OFF has no consent write");
  await database.exec("UPDATE feature_flags SET enabled=true WHERE flag IN ('media_dubbing_enabled','media_derivative_jobs_enabled')");
  await assert.rejects(grant(other)); checks++;
  equal(await scalar("SELECT media_dubbing_grant($1,$2,1,'en-US',$3,$4,false,'synthetic-dubbing-v1',$5)", [asset, owner, source.captionRevision, source.translationRevision, "0".repeat(64)]), null, "explicit false refused");
  equal((await store.consentState({ assetId: asset, actorId: owner, targetLanguage: "en-US" })).consentRevision, "0".repeat(64), "fresh owner receives initial compare token");
  await assert.rejects(store.consentState({ assetId: asset, actorId: other, targetLanguage: "en-US" })); checks++;
  await store.revoke({ assetId: asset, actorId: owner });
  await assert.rejects(grant(owner, "0".repeat(64)), (error) => error instanceof DubbingError && error.code === "source_revoked", "store does not rebase a delayed initial request after empty withdrawal"); checks++;
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_consents"), 0, "stale initial store request writes no consent");
  const capturedEpoch = (await store.consentState({ assetId: asset, actorId: owner, targetLanguage: "en-US" })).consentRevision;
  equal(capturedEpoch !== "0".repeat(64), true, "store returns the persisted asset-wide withdrawal epoch");
  equal((await store.consentState({ assetId: asset, actorId: owner, targetLanguage: "fr" })).consentRevision, capturedEpoch, "never-seen language inherits the asset epoch through actual store RPC");
  const input = await grant(owner, capturedEpoch);
  equal((await grant()).consentRevision, input.consentRevision, "idempotent consent retry");
  equal((await grant(owner, capturedEpoch)).consentRevision, input.consentRevision, "same captured opt-in token retries idempotently before revocation");
  const context = await claimed(input);
  const output = await renderDubbing(input, engine, { signal: context.signal, assertCurrent: store.assertCurrent });
  await database.exec("BEGIN");
  try {
    await database.query("UPDATE media_derivative_jobs SET lease_until=now()+interval '20 milliseconds' WHERE id=$1", [context.job.id]);
    await delay(65);
    equal(await scalar("SELECT media_dubbing_stage($1,$2,$3,$4::jsonb,'media-private-fixture')", [context.job.id, context.job.token, badToken, JSON.stringify(output.manifest)]), false, "staging refuses a lease that expired after transaction start");
    equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 0, "expired staging leaves no retained artifact");
  } finally { await database.exec("ROLLBACK"); }
  publicBucket = true;
  await assert.rejects(store.stage(context, output.audio, output.manifest)); checks++;
  equal(uploadCount, 0, "public bucket cannot receive audio"); publicBucket = false;
  const foreign = { ...context, job: { ...context.job, token: badToken } };
  await assert.rejects(store.stage(foreign, output.audio, output.manifest)); checks++;
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 0, "foreign lease cannot stage metadata");
  equal(uploadCount, 0, "foreign lease cannot upload");
  await database.exec("BEGIN");
  try {
    uploadFailure = true;
    await assert.rejects(store.stage(context, output.audio, output.manifest), (error) => error instanceof DubbingError && error.code === "cleanup_failed"); checks++;
    equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts WHERE write_state='pending' AND cleanup_requested"), 1, "ambiguous upload failure preserves its pending cleanup identity");
  } finally { uploadFailure = false; await database.exec("ROLLBACK"); }
  const staged = await store.stage(context, output.audio, output.manifest);
  equal(storage.size, 1, "private object stored");
  await store.remove(foreign, staged.artifactId);
  equal(storage.size, 1, "foreign lease cannot erase a stored WAV");
  equal(await scalar("SELECT cleanup_requested FROM media_dubbing_artifacts WHERE id=$1", [staged.artifactId]), false, "foreign cleanup does not hide another artifact");
  equal(await scalar("SELECT media_dubbing_settle($1,$2,$3,false)", [context.job.id, context.job.token, staged.artifactId]), false, "settled uploaded writer cannot be relabeled never-started");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 0, "staged is not published");
  equal(await scalar("SELECT media_derivative_finish($1,$2,true,false,NULL,1,1,$3,$4::jsonb)", [context.job.id, context.job.token, output.audio.length, JSON.stringify({ artifactId: staged.artifactId, publicationToken: context.job.token })]), true, "shared queue completes owned job");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 1, "completed artifact visible to protected server");
  const read = await store.read({ assetId: asset, viewerId: owner, targetLanguage: "en-US" });
  equal(read?.audio, output.audio, "actual store reads complete bytes");
  viewerAllowed = false;
  equal(await store.read({ assetId: asset, viewerId: other, targetLanguage: "en-US" }), null, "viewer authorization blocks storage read"); viewerAllowed = true;
  await database.exec("UPDATE media_assets SET moderation_status='limited'");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 0, "moderation hold suppresses completed artifact");
  await database.exec("UPDATE media_assets SET moderation_status='approved'");
  equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, "restore does not restore consent");
  await assert.rejects(store.assertCurrent(input)); checks++;
  const replacement = await grant();
  assert.notEqual(replacement.consentRevision, input.consentRevision); checks++;
  const replacementContext = await claimed(replacement);
  const replacementOutput = await renderDubbing(replacement, engine, { signal: replacementContext.signal, assertCurrent: store.assertCurrent });
  await store.stage(replacementContext, replacementOutput.audio, replacementOutput.manifest);
  cleanupFailure = true;
  await assert.rejects(store.revoke({ assetId: asset, actorId: owner }), (error) => error instanceof DubbingError && error.code === "cleanup_failed"); checks++;
  equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, "revocation durable despite storage deletion failure");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 0, "cleanup failure cannot expose bytes");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 2, "cleanup ledger retained on deletion failure");
  await assert.rejects(store.stage(replacementContext, replacementOutput.audio, replacementOutput.manifest)); checks++;
  cleanupFailure = false;
  await store.revoke({ assetId: asset, actorId: owner });
  equal(storage.size, 0, "revocation retry removes physical test objects");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 0, "revocation retry removes artifact rows");
  await assert.rejects(grant(owner, replacement.consentRevision), (error) => error instanceof DubbingError && error.code === "source_revoked", "pre-revocation consent request cannot reauthorize after revocation"); checks++;
  equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, "stale retry leaves consent withdrawn");
  const deletionInput = await grant();
  const deletionContext = await claimed(deletionInput);
  const deletionOutput = await renderDubbing(deletionInput, engine, { signal: deletionContext.signal, assertCurrent: store.assertCurrent });
  await store.stage(deletionContext, deletionOutput.audio, deletionOutput.manifest);
  await database.exec("DELETE FROM media_assets");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 0, "hard deletion cannot serve a derivative");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 1, "orphan removal key retained across source deletion");
  const missingBucketStore = createDubbingStore(client, undefined, { loadTranslatedSource: async () => structuredClone(source), canRead: async () => viewerAllowed });
  await assert.rejects(missingBucketStore.eraseOwned(owner), (error) => error instanceof DubbingError && error.code === "cleanup_failed"); checks++;
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 1, "missing bucket preserves retained erasure key");
  equal(storage.size, 1, "missing bucket does not pretend physical deletion");
  equal(await store.eraseOwned(owner), 1, "account erasure hook removes retained object");
  equal(storage.size, 0, "no orphan bytes after erasure hook");
  await database.query("INSERT INTO media_assets VALUES($1,$2,1,'post-media','owner/original.mp4',100,NULL,'none','ready','approved')", [asset, owner]);
  await database.query("INSERT INTO media_caption_manifests VALUES($1,1,$2,$3)", [asset, source.captionRevision, `manual-captions/${asset}/v1-${source.captionRevision}.json`]);
  const integratedInput = await grant();
  const queue = createMediaJobQueue(client);
  await queue.enqueue({ assetId: asset, ownerUserId: owner, sourceVersion: 1, kind: "dubbing", modelVersion: engine.modelVersion, targetLanguage: "en-US", revisionKey: dubbingRevision(integratedInput, engine) });
  const handler = createDubbingHandler({ ...store, engine, jobError: (code, retryable) => new MediaJobError(code, retryable) });
  const pass = await runMediaWorkerPass(queue, handler, { enabled: true, concurrency: 1, leaseSeconds: 120, signal: new AbortController().signal });
  equal(pass.completed, 1, "actual parent worker and queue finish this handler");
  equal(pass.failed, 0, "integrated pass has no failure");
  equal(pass.cleanupFailed, 0, "integrated pass has no cleanup error");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 1, "integrated publication visible through fenced view");
  equal((await store.read({ assetId: asset, viewerId: owner, targetLanguage: "en-US" }))?.audio.subarray(0, 4).toString(), "RIFF", "integrated output is real PCM WAV bytes");
  cancelDuringDownload = true;
  await assert.rejects(store.read({ assetId: asset, viewerId: owner, targetLanguage: "en-US" }), (error) => error instanceof DubbingError && error.code === "source_revoked"); checks++;
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 0, "publication cancellation during download prevents output return");
  cancelDuringDownload = false;
  await store.revoke({ assetId: asset, actorId: owner });
  equal(storage.size, 0, "race fixture begins with no retained objects");
  const raceInput = await grant();
  const raceContext = await claimed(raceInput);
  let releaseUpload!: () => void;
  const uploadStarted = new Promise<void>((resolve) => { uploadBegan = resolve; });
  uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const raced = handler.handle(raceContext).then((value) => ({ value, error: undefined }), (error) => ({ value: undefined, error }));
  await uploadStarted;
  const pendingRow: any = (await database.query("SELECT * FROM media_dubbing_artifacts")).rows[0];
  equal(pendingRow.write_state, "pending", "write reservation is durable before upload completes");
  equal(pendingRow.storage_bucket, "media-private-fixture", "cleanup records exact destination bucket");
  await database.exec("BEGIN");
  try {
    await database.query("UPDATE media_derivative_jobs SET state='completed',lease_token=NULL,lease_until=NULL,result=$2::jsonb WHERE id=$1", [raceContext.job.id, JSON.stringify({ artifactId: pendingRow.id, publicationToken: raceContext.job.token })]);
    equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 0, "queue completion cannot publish a pending writer without uploaded acknowledgement");
  } finally { await database.exec("ROLLBACK"); }
  equal(await scalar("SELECT media_dubbing_settle($1,$2,$3,true)", [raceContext.job.id, badToken, pendingRow.id]), false, "foreign lease cannot settle pending write");
  await store.remove({ ...raceContext, job: { ...raceContext.job, token: badToken } }, pendingRow.id);
  equal(await scalar("SELECT cleanup_requested FROM media_dubbing_artifacts WHERE id=$1", [pendingRow.id]), false, "foreign lease cannot retire artifact");
  equal(await scalar("SELECT media_dubbing_revoke($1,$2)", [asset, owner]), true, "revocation can commit before the API process attempts erasure");
  equal(await scalar("SELECT cleanup_requested FROM media_dubbing_artifacts WHERE id=$1", [pendingRow.id]), true, "revocation atomically marks cleanup even if API crashes before storage removal");
  await assert.rejects(store.revoke({ assetId: asset, actorId: owner }), (error) => error instanceof DubbingError && error.code === "cleanup_failed"); checks++;
  equal(storage.size, 0, "early remove finds no object but does not prove writer completion");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts WHERE write_state='pending' AND cleanup_requested"), 1, "revocation retains pending writer tombstone");
  equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, "consent is withdrawn despite pending erasure");
  equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [raceContext.job.id]), "cancelled", "revocation cancels publication");
  equal(await scalar("SELECT media_dubbing_forget($1,$2,NULL,NULL)", [pendingRow.id, owner]), false, "pending write cannot be forgotten by cleanup RPC");
  await assert.rejects(database.query("DELETE FROM media_dubbing_artifacts WHERE id=$1", [pendingRow.id])); checks++;
  releaseUpload();
  const raceResult = await raced;
  assert(raceResult.error instanceof MediaJobError && raceResult.error.code === "source_revoked"); checks++;
  uploadGate = undefined; uploadBegan = undefined;
  equal(storage.size, 0, "late successful upload is erased by its own revoked lease");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 0, "settled own-lease cleanup leaves no orphan ledger or bytes");
  await store.revoke({ assetId: asset, actorId: owner });

  const cancelledInput = await grant();
  const cancelledContext = await claimed(cancelledInput);
  const cancelledOutput = await renderDubbing(cancelledInput, engine, { signal: cancelledContext.signal, assertCurrent: store.assertCurrent });
  const cancellation = new AbortController();
  cancelAfterReservation = () => cancellation.abort();
  const beforeCancelledUpload = uploadCount;
  await assert.rejects(store.stage({ ...cancelledContext, signal: cancellation.signal }, cancelledOutput.audio, cancelledOutput.manifest), (error) => error instanceof DubbingError && error.code === "cancelled"); checks++;
  cancelAfterReservation = undefined;
  equal(uploadCount, beforeCancelledUpload, "cancellation before invoking storage never starts a writer");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 0, "known never-started writer can settle aborted and clean up");

  ambiguousUpload = true;
  await assert.rejects(store.stage(cancelledContext, cancelledOutput.audio, cancelledOutput.manifest), (error) => error instanceof DubbingError && error.code === "cleanup_failed"); checks++;
  ambiguousUpload = false;
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts WHERE write_state='pending' AND cleanup_requested"), 1, "lost upload response retains durable cleanup identity");
  const unknownRow: any = (await database.query("SELECT * FROM media_dubbing_artifacts")).rows[0];
  await database.query("UPDATE media_derivative_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND state='processing'", [cancelledContext.job.id]);
  await database.exec("UPDATE feature_flags SET enabled=false;");
  await assert.rejects(store.revoke({ assetId: asset, actorId: owner }), (error) => error instanceof DubbingError && error.code === "cleanup_failed"); checks++;
  await database.exec("DELETE FROM media_assets");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts"), 1, "crash/lease expiry/source hard-delete cannot erase the pending identity");
  assert(lateUpload); storage.set(lateUpload.path, lateUpload.bytes); checks++;
  equal(storage.size, 1, "ambiguous remote upload can complete after the worker returned and source disappeared");
  const changedBucketStore = createDubbingStore(client, "other-private-fixture", { loadTranslatedSource: async () => structuredClone(source), canRead: async () => false });
  await assert.rejects(changedBucketStore.eraseOwned(owner), (error) => error instanceof DubbingError && error.code === "cleanup_failed"); checks++;
  equal(storage.size, 1, "changed configured bucket cannot delete the original ledger or bytes");
  const restartedStore = createDubbingStore(client, "media-private-fixture", { loadTranslatedSource: async () => { throw new Error("cleanup must not load captions or a model"); }, canRead: async () => false });
  await assert.rejects(restartedStore.eraseOwned(owner), (error) => error instanceof DubbingError && error.code === "cleanup_failed"); checks++;
  equal(storage.size, 0, "fresh cleanup instance removes late bytes while OFF and after source deletion");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_artifacts WHERE id=$1 AND write_state='pending'", [unknownRow.id]), 1, "physical removal is not falsely reported as completed erasure while writer outcome remains unknown");
  equal(await scalar("SELECT count(*)::int FROM media_dubbing_readable"), 0, "unsettled artifacts never become readable");
  console.log(JSON.stringify({ status: "passed", checks, database: "actual isolated PGlite SQL including parent 3980", storage: "in-memory protocol fixture, not Supabase Storage proof" }));
} finally { await database.close(); }
